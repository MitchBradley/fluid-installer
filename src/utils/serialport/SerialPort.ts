import { ESPLoader, LoaderOptions, Transport } from "esptool-js";
import { DeviceInfo } from "../flash";
import { NativeSerialPort } from "./typings";
import { Buffer } from "buffer";
import { sleep } from "../utils";

export enum SerialPortState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    DISCONNECTING
}

export type SerialReader = (data: Buffer) => void;
export type LineReader = (data: string) => void;

// Use the lower baud rate for getting the chip info, since it is
// more reliable and fast enough for the purpose.
const INFO_BAUD_RATE = 115200;
const MAX_SAVED_LINES = 1000;

// Detects *embedded* PSRAM (as found on WROOM-1 N8R2/N8R8 modules -- not an
// external PSRAM chip on a custom board) from the ESP32-S3's PSRAM_CAP
// efuse field, per Espressif's efuse table (esp_efuse_table.csv, EFUSE_BLK1
// bits 131-132 + bit 179): 0 None, 1 8M, 2 2M, 3 16M, 4 4M.
//
// esptool-js's own ESP32S3ROM.getPsramCap() only reads the low 2 bits
// (EFUSE_BLK1 bits 131-132) and silently drops the high bit (bit 179), so
// it can only ever return 0-3 -- any chip whose real cap is 4 or higher
// (e.g. a 4MB-PSRAM chip, cap 4) misreads as cap 0 ("no PSRAM"). Confirmed
// against the actual esptool.py (targets/esp32s3.py get_psram_cap) and
// still present in esptool-js 0.7.0 (latest as of this writing), so we
// read both efuse words ourselves instead of trusting the library.
//
// Espressif does not expose PSRAM bus width (Quad vs Octal) as a readable
// efuse at all -- only capacity. The Quad/Octal mapping below is by
// module-part-number convention, not a documented bit:
//   cap 1 (8MB)  -> Octal, WROOM-1 R8
//   cap 2 (2MB)  -> Quad,  WROOM-1 R2
//   cap 3 (16MB) -> Octal, WROOM-2 R16V (per its datasheet)
//   cap 4 (4MB)  -> unknown, and deliberately left unmapped rather than
//     guessed: no mainstream module reports 4MB, the one chip we tested
//     it on was an "E2" *engineering sample* (per its marking) where
//     Espressif itself doesn't guarantee efuse-burned values -- including
//     PSRAM_CAP -- are meaningful at all, and empirically neither driver
//     could initialize that chip's PSRAM anyway ("PSRAM chip is not
//     connected, or wrong PSRAM line mode" from both quad_psram and
//     octal_psram). So there's nothing reliable to map cap 4 to; leaving
//     it undefined makes the installer show all variants unfiltered.
const PSRAM_CAP_MAP: Record<number, "none" | "quad" | "octal" | undefined> = {
    0: "none",
    1: "octal",
    2: "quad",
    3: "octal"
};

type ChipWithEfuseBlock1 = {
    CHIP_NAME: string;
    EFUSE_BLOCK1_ADDR: number;
};

async function detectPsram(
    loader: ESPLoader
): Promise<"none" | "quad" | "octal" | undefined> {
    const chip = loader.chip as unknown as Partial<ChipWithEfuseBlock1>;
    if (
        chip.CHIP_NAME !== "ESP32-S3" ||
        typeof chip.EFUSE_BLOCK1_ADDR !== "number"
    ) {
        return undefined;
    }
    try {
        const block1 = chip.EFUSE_BLOCK1_ADDR;
        const word4 = await loader.readReg(block1 + 4 * 4);
        const word5 = await loader.readReg(block1 + 4 * 5);
        const capLow2 = (word4 >> 3) & 0x03;
        const capHiBit = (word5 >> 19) & 0x01;
        const cap = (capHiBit << 2) | capLow2;
        return PSRAM_CAP_MAP[cap];
    } catch (error) {
        console.log("Could not read PSRAM efuse:", error);
        return undefined;
    }
}

export enum SerialPortEvent {
    DISCONNECTED,
    CONNECTION_ERROR
}

const espLoaderTerminal = {
    clean() {},
    // eslint-disable-next-line
    writeLine(data) {},
    write(data) {
        console.log(data);
    }
};

export class SerialPort {
    dispatchEvent(eventType: SerialPortEvent) {
        const listenersList: (() => void)[] =
            this.listeners.get(eventType) ?? [];
        listenersList.forEach((listener) => listener());
    }
    on(eventType: SerialPortEvent, callback: () => void) {
        const listenersList: (() => void)[] =
            this.listeners.get(eventType) ?? [];
        listenersList.push(callback);
        this.listeners.set(eventType, listenersList);
    }

    private listeners: Map<SerialPortEvent, (() => void)[]> = new Map();
    private serialPort: NativeSerialPort;
    private state: SerialPortState = SerialPortState.DISCONNECTED;
    private reader: ReadableStreamDefaultReader<Uint8Array>;
    private exclusiveReader: SerialReader | undefined = undefined;
    private readers: SerialReader[] = [];
    private lineReaders: LineReader[] = [];
    private reading: boolean = false;
    private deviceInfo: DeviceInfo;
    private dtrState: boolean = false;
    private savedData: Buffer[] = [];

    constructor(serialPort: NativeSerialPort) {
        this.serialPort = serialPort;
    }

    getInfo = async (): Promise<DeviceInfo> => {
        if (this.deviceInfo) {
            return Promise.resolve(this.deviceInfo);
        }

        if (this.state === SerialPortState.CONNECTED) {
            await this.close();
        }

        const transport = new Transport(this.serialPort);
        try {
            const loaderOptions = {
                transport,
                baudrate: INFO_BAUD_RATE,
                terminal: espLoaderTerminal
            } as LoaderOptions;
            const loader = new ESPLoader(loaderOptions);
            await loader.main();

            // We need to wait after connecting...
            await new Promise((f) => setTimeout(f, 500));
            const flashId = await loader.readFlashId();
            const flashIdLowbyte = (flashId >> 16) & 0xff;

            this.deviceInfo = {
                mcu: loader.chip.CHIP_NAME,
                description: await loader.chip.getChipDescription(loader),
                features: await loader.chip.getChipFeatures(loader),
                frequency: await loader.chip.getCrystalFreq(loader),
                mac: await loader.chip.readMac(loader),
                manufacturer: (flashId & 0xff).toString(16),
                flashId: flashId,
                device:
                    ((flashId >> 8) & 0xff).toString(16) +
                    flashIdLowbyte.toString(16),
                flashSize: loader.DETECTED_FLASH_SIZES[flashIdLowbyte],
                psram: await detectPsram(loader)
            };

            return Promise.resolve(this.deviceInfo);
        } finally {
            // Reset the controller
            await transport.setRTS(true);
            await transport.setDTR(false);
            await new Promise((resolve) => setTimeout(resolve, 100));
            await transport.setDTR(true);
            await new Promise((resolve) => setTimeout(resolve, 100));
            await transport.disconnect();
            await this.open();
        }
        return Promise.reject();
    };

    async setDTR(enabled: boolean) {
        this.dtrState = enabled;
        await this.serialPort.setSignals({ dataTerminalReady: enabled });
    }

    async setRTS(enabled: boolean) {
        await this.serialPort.setSignals({ requestToSend: enabled });
        this.setDTR(this.dtrState);
    }

    open = async (baudRate = 115200): Promise<void> => {
        if (this.state === SerialPortState.DISCONNECTING) {
            await new Promise((r) => setTimeout(r, 1000));
        }

        if (this.state === SerialPortState.CONNECTED) {
            return Promise.reject("Already connected");
        }

        this.state = SerialPortState.CONNECTING;
        return this.serialPort
            .open({ baudRate, bufferSize: 10000 })
            .then(() => {
                this.state = SerialPortState.CONNECTED;
                this.startReading();
            })
            .catch((error) => {
                this.dispatchEvent(SerialPortEvent.CONNECTION_ERROR);
                throw error;
            });
    };

    isOpen() {
        return (
            this.state === SerialPortState.CONNECTED ||
            this.state === SerialPortState.CONNECTING
        );
    }

    close = async (): Promise<void> => {
        if (this.state !== SerialPortState.CONNECTED) {
            return Promise.reject("Not connected");
        }

        this.state = SerialPortState.DISCONNECTING;
        this.reading = false;
        while (this.serialPort.readable?.locked) {
            this.reader.cancel();
            await sleep(10);
        }

        return this.serialPort.close().then(() => {
            console.log("SerialPort disconnected");
            this.state = SerialPortState.DISCONNECTED;
        });
    };

    getSavedData = (): Buffer[] => {
        return this.savedData;
    };

    getState = (): SerialPortState => {
        return this.state;
    };

    getReaders(): SerialReader[] {
        return this.readers;
    }

    getLineReaders(): LineReader[] {
        return this.lineReaders;
    }

    getNativeSerialPort = (): NativeSerialPort => {
        return this.serialPort;
    };

    write = async (data: Buffer): Promise<void> => {
        if (this.state !== SerialPortState.CONNECTED) {
            return Promise.reject("Not connected");
        }

        try {
            while (this.serialPort.writable.locked) {
                await sleep(100);
            }

            const writer = this.serialPort.writable!.getWriter();
            return writer.write(data).finally(() => {
                writer.releaseLock();
            });
        } catch (error) {
            console.log(
                "Got error while trying to release lock, ignore...",
                error
            );
            return Promise.resolve();
        }
    };

    writeln = async (line: string): Promise<void> => {
        const toSend = Buffer.from(line + "\n");
        this.savedData.push(toSend);
        if (this.savedData.length > MAX_SAVED_LINES) {
            this.savedData.slice(this.savedData.length - MAX_SAVED_LINES);
        }
        this.write(toSend);
    };

    writeChar = async (char: number): Promise<void> => {
        if (char >= 0x20 && char < 0x7f) {
            // Printable
            this.savedData.push(Buffer.from([char]));
        } else {
            const msg = "[0x" + char.toString(16) + "]";
            this.savedData.push(Buffer.from(msg));
        }
        this.write(Buffer.from([char]));
    };

    /**
     * Sets a reader to receive the data exclusively, blocking all
     * other readers.  This is used for things like XModem whose data
     * cannot be interpreted in the normal fashion.  At most one
     * exclusive reader can be active.
     *
     * @param reader
     */
    setExclusiveReader = (reader: SerialReader): void => {
        this.exclusiveReader = reader;
    };

    /**
     * Removes the exclusive reader so other readers can receive data.
     */
    removeExclusiveReader = (): void => {
        this.exclusiveReader = undefined;
    };

    /**
     * Adds a reader that will be notified everytime there is serial data
     *
     * @param reader
     * @returns a function for unregistering the reader
     */
    addReader = (reader: SerialReader): (() => void) => {
        this.readers.push(reader);

        // Return method for removing the reader
        return () => this.removeReader(reader);
    };

    removeReader = (reader: SerialReader) => {
        this.readers = this.readers.filter((r) => r !== reader);
    };

    /**
     * Adds a reader that will be notified everytime there is a line of serial data
     *
     * @param reader
     * @returns a function for unregistering the reader
     */
    addLineReader = (reader: LineReader): (() => void) => {
        this.lineReaders.push(reader);

        // Return method for removing the reader
        return () => this.removeLineReader(reader);
    };

    removeLineReader = (reader: LineReader) => {
        this.lineReaders = this.lineReaders.filter((r) => r !== reader);
    };

    hardReset = async () => {
        await this.serialPort.setSignals({
            dataTerminalReady: false,
            requestToSend: true
        });
        await new Promise((r) => setTimeout(r, 100));
        await this.serialPort.setSignals({ requestToSend: false });
        await new Promise((r) => setTimeout(r, 50));
    };

    // This is used to hold the ESP32 in reset if it is stuck in a reboot loop
    holdReset = async () => {
        await this.serialPort.setSignals({
            dataTerminalReady: false,
            requestToSend: true
        });
        await new Promise((r) => setTimeout(r, 100));
    };

    private startReading = async () => {
        const decoder = new TextDecoder();
        let lineBuffer: string = "";
        this.reading = true;
        while (
            // this.close() sets reading to false to make the loop exit
            this.reading &&
            this.state === SerialPortState.CONNECTED &&
            this.serialPort.readable
        ) {
            try {
                this.reader = this.serialPort.readable.getReader();
                // We set a timeout to interrupt stalled reads so that
                // external code can easily stop the read loop without
                // needing the .reader variable
                const { value, done } = await this.reader.read();
                this.reader.releaseLock();
                if (done) {
                    // We get here when this.close() executes this.reader.cancel()
                    return;
                }

                const valueAsBuffer = Buffer.from(value);
                this.savedData.push(valueAsBuffer);
                if (this.exclusiveReader) {
                    this.exclusiveReader(valueAsBuffer);
                } else {
                    this.readers.forEach((reader) => reader(valueAsBuffer));
                    lineBuffer += decoder.decode(value).replace(/\r/g, "");
                    while (true) {
                        const pos = lineBuffer.indexOf("\n");
                        if (pos == -1) {
                            break;
                        }
                        const line = lineBuffer.substring(0, pos);
                        lineBuffer = lineBuffer.slice(pos + 1);
                        this.lineReaders.forEach((reader) => reader(line));
                    }
                }
            } catch (error) {
                if (error.message === "Releasing Default reader") {
                    // Timeout; retry
                    continue;
                }
                if (error instanceof Error) {
                    const nonFatal = [
                        "BufferOverrunError",
                        "FramingError",
                        "BreakError",
                        "ParityError"
                    ];
                    if (nonFatal.includes(error.name)) {
                        // Retryable
                        continue;
                    }
                }
                console.error(error);
                throw error;
                // this.dispatchEvent(SerialPortEvent.CONNECTION_ERROR);
            }
        }
    };
}
