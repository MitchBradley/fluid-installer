import {
    SerialBufferedReader,
    SerialPort
} from "../../utils/serialport/SerialPort";
import { NativeSerialPortEvent } from "../../utils/serialport/typings";
import { sleep } from "../../utils/utils";
import { XModem, XModemSocket } from "../../utils/xmodem/xmodem";
import { Command, CommandState } from "./commands/Command";
import { GetStatsCommand, Stats } from "./commands/GetStatsCommand";
import { PingCommand } from "./commands/PingCommand";

class XModemSocketAdapter implements XModemSocket {
    private serialPort: SerialPort;
    private buffer: Buffer = Buffer.alloc(0);
    private unregister: () => void;

    constructor(serialPort: SerialPort) {
        this.serialPort = serialPort;

        // Registers a reader and store the function for unregistering
        this.unregister = this.serialPort.addReader((data) =>
            this.onData(data)
        );
    }

    onData(data: Buffer) {
        if (!this.buffer) {
            this.buffer = data;
        } else {
            this.buffer = Buffer.concat([this.buffer, data]);
        }
    }

    write(buffer) {
        return this.serialPort.write(buffer);
    }

    read(): Promise<Buffer> {
        const result = this.buffer;
        this.buffer = Buffer.alloc(0);
        return Promise.resolve(result);
    }

    peekByte(): Promise<number | undefined> {
        return Promise.resolve(this.buffer.at(0));
    }

    close() {
        this.unregister && this.unregister();
    }
}

export enum ControllerStatus {
    CONNECTION_LOST,
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    UNKNOWN_DEVICE
}

const MAX_PING_COUNT = 10;

export type ControllerStatusListener = (status: ControllerStatus) => void;

export class ControllerService {
    serialPort: SerialPort;
    buffer: string;
    commands: Command[];
    xmodemMode: boolean = false;
    status: ControllerStatus = ControllerStatus.DISCONNECTED;
    currentVersion: string | undefined;
    statusListeners: ControllerStatusListener[];
    stats: Stats;

    constructor(serialPort: SerialPort) {
        this.serialPort = serialPort;
        this.buffer = "";
        this.commands = [];
        this.statusListeners = [];
    }

    async getStats() {
        if (!this.stats && this.currentVersion) {
            console.log("Getting stats");
            try {
                const command = await this.send(new GetStatsCommand(), 5000);
                this.stats = command.getStats();
            } catch (error) {
                console.warn("Could not retreive the controller status", error);
            }
        }
        return this.stats;
    }

    connect = async (): Promise<ControllerStatus> => {
        if (!this.serialPort.isOpen()) {
            const bufferedReader = new SerialBufferedReader();
            await this.serialPort.open(115200);

            this.serialPort
                .getNativeSerialPort()
                .addEventListener(NativeSerialPortEvent.DISCONNECT, () => {
                    this._notifyStatus(ControllerStatus.CONNECTION_LOST);
                });

            try {
                this.serialPort.addReader(bufferedReader.getReader());
                // Send reset echo mode and reset controller
                await this.serialPort.write(Buffer.from([0x0c, 0x18]));
                await this._initializeController(bufferedReader);
            } finally {
                this.serialPort.removeReader(bufferedReader.getReader());
            }

            this.status = ControllerStatus.CONNECTED;
            this.serialPort.addReader(this.onData);
        }

        await this.getStats();

        return Promise.resolve(this.status);
    };

    private async _initializeController(bufferedReader: SerialBufferedReader) {
        const gotWelcomeString = await this.waitForWelcomeString(
            bufferedReader
        );
        if (gotWelcomeString) {
            await this.waitForSettle(bufferedReader);

            // Clear send and read buffers
            await this.serialPort.write(Buffer.from("\n"));
            await bufferedReader.waitForLine(2000);

            // Try and query for version
            await this.serialPort.write(Buffer.from("$I\n"));
            const versionResponse = await bufferedReader.waitForLine(2000);
            this.currentVersion = versionResponse.toString();
            console.log("Got version: " + this.currentVersion);
            await this.waitForSettle(bufferedReader);
        }
    }

    private async waitForSettle(
        bufferedReader: SerialBufferedReader,
        waitTimeMs = 500
    ) {
        while ((await bufferedReader.waitForLine(waitTimeMs)).length > 0) {
            await sleep(100);
        }
    }

    private async waitForWelcomeString(bufferedReader: SerialBufferedReader) {
        console.log("Waiting for welcome string");
        const currentTime = Date.now();

        while (currentTime + 15000 > Date.now()) {
            try {
                const response = await bufferedReader.readLine();
                if (this.isWelcomeString(response.toString())) {
                    console.log("Found welcome message: " + response);
                    return true;
                }
                await sleep(100);
            } catch (error) {
                console.log(error);
            }
        }

        console.log("Could not detect welcome string");
        return false;
    }

    async _detectController(): Promise<void> {
        // Attemt to establish a connection
        const answered = false;
        let pingCount = 0;
        while (!answered) {
            pingCount++;
            try {
                await this.ping();
                return Promise.resolve();
            } catch (error) {
                console.debug("Waiting for response... " + pingCount);
            }
            if (pingCount >= MAX_PING_COUNT) {
                this.status = ControllerStatus.UNKNOWN_DEVICE;
                return Promise.reject("Could not detect controller...");
            }
        }
    }

    async ping(): Promise<void> {
        const pingCommand = new PingCommand();
        try {
            await this.send(pingCommand, 1000);
            this.status = ControllerStatus.CONNECTED;
            return Promise.resolve();
        } catch (error) {
            return Promise.reject();
        }
    }

    disconnect(notify = true): Promise<void> {
        this.serialPort.removeReader(this.onData);
        if (notify) {
            this._notifyStatus(ControllerStatus.DISCONNECTED);
        }
        return this.serialPort.close();
    }

    onData = (data: Buffer) => {
        if (this.xmodemMode) {
            return;
        }

        this.buffer += data.toString().replace(/\r/g, "");

        let endLineIndex = this.buffer.indexOf("\n");
        while (endLineIndex >= 0) {
            const line = this.buffer.substring(0, endLineIndex);
            this.buffer = this.buffer.substring(endLineIndex + 1);
            console.log("<<< " + line);

            if (this.commands.length) {
                this.commands[0].appendLine(line);
                if (this.commands[0].state == CommandState.DONE) {
                    this.commands = this.commands.slice(1);
                }
            }
            endLineIndex = this.buffer.indexOf("\n");
        }
    };

    send = <T extends Command>(
        command: T,
        timeoutMs: number = 0
    ): Promise<T> => {
        this.commands.push(command);
        const result = new Promise<T>((resolve, reject) => {
            let timer;
            if (timeoutMs > 0) {
                timer = setTimeout(() => {
                    this._removeCommand(command);
                    reject("Command timed out");
                }, timeoutMs);
            }
            (command as Command).onDone = async () => {
                if (timer) {
                    clearTimeout(timer);
                }
                resolve(command);
            };
        });
        this.serialPort.write(Buffer.from((command as Command).command + "\n"));
        return result;
    };

    _removeCommand = (command: Command) => {
        this.commands = this.commands.filter((c) => c !== command);
    };

    downloadFile = async (file: string): Promise<Buffer> => {
        this.xmodemMode = true;
        await this.serialPort.write(Buffer.from("$X\r\n"));
        await new Promise((resolve) => setTimeout(resolve, 300));

        await this.serialPort.write(
            Buffer.from("$Xmodem/Send=" + file + "\r\n")
        );
        await new Promise((resolve) => setTimeout(resolve, 500));

        const xmodem = new XModem(new XModemSocketAdapter(this.serialPort));
        const fileData = await xmodem.receive();
        xmodem.close();
        this.xmodemMode = false;

        return Promise.resolve(fileData);
    };

    uploadFile = async (file: string, fileData: Buffer): Promise<void> => {
        this.xmodemMode = true;
        await this.serialPort.write(Buffer.from("$X\r\n"));
        await new Promise((resolve) => setTimeout(resolve, 300));

        await this.serialPort.write(
            Buffer.from("$Xmodem/Receive=" + file + "\r\n")
        );
        await new Promise((resolve) => setTimeout(resolve, 500));

        const xmodem = new XModem(new XModemSocketAdapter(this.serialPort));
        await xmodem.send(fileData);
        xmodem.close();
        this.xmodemMode = false;

        await new Promise((resolve) => setTimeout(resolve, 3000));
        return Promise.resolve();
    };

    hardReset = async () => {
        await this.serialPort.hardReset();
        const bufferedReader = new SerialBufferedReader();

        try {
            this.serialPort.addReader(bufferedReader.getReader());
            await this._initializeController(bufferedReader);
        } finally {
            this.serialPort.removeReader(bufferedReader.getReader());
        }
        return Promise.resolve();
    };

    private isWelcomeString(response: string | undefined) {
        if (response) {
            console.log(response);
        }
        return (
            response &&
            (response.startsWith("GrblHAL ") ||
                response.startsWith("Grbl ") ||
                response.indexOf(" [FluidNC v") > 0)
        );
    }

    addListener(listener: ControllerStatusListener) {
        this.statusListeners.push(listener);
    }

    removeListener(listener: ControllerStatusListener) {
        this.statusListeners = this.statusListeners.filter(
            (l) => l !== listener
        );
    }

    private _notifyStatus(status: ControllerStatus) {
        this.statusListeners.forEach((l) => l(status));
    }
}
