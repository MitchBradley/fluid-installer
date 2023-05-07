import JSZip from "jszip";

import { GithubRelease, GithubService } from "./GitHubService";
import { SerialPort } from "../utils/serialport/SerialPort";
import { flashDevice } from "../utils/flash";
import { convertUint8ArrayToBinaryString } from "../utils/utils";

export enum FirmwareType {
    WIFI = "wifi",
    BLUETOOTH = "bt"
}

export enum InstallerState {
    SELECT_PACKAGE,
    DOWNLOADING,
    EXTRACTING,
    FLASHING,
    DONE,
    ERROR
}

const findFileInZip = (zip: any, fileName: any): any => {
    const file = Object.values(zip.files).find((file: any) =>
        file.name.endsWith(fileName)
    );
    if (!file) {
        throw new Error("Missing file '" + fileName + "' from package");
    }
    return file;
};

/**
 * Unzips the given data and returns a promise with four files
 * @param {string} zipData
 * @param {FirmwareType} firmwareType
 * @returns
 */
const unzipAssetData = (
    zipData: any,
    firmwareType: FirmwareType = FirmwareType.WIFI
) => {
    return JSZip.loadAsync(zipData).then((zip: any) => {
        const bootLoaderFile = findFileInZip(
            zip,
            "/" + firmwareType + "/bootloader.bin"
        );
        const bootAppFile = findFileInZip(zip, "/common/boot_app0.bin");
        const firmwareFile = findFileInZip(
            zip,
            "/" + firmwareType + "/firmware.bin"
        );
        const partitionsFile = findFileInZip(
            zip,
            "/" + firmwareType + "/partitions.bin"
        );

        return Promise.all([
            zip.file(bootLoaderFile.name).async("uint8array"),
            zip.file(bootAppFile.name).async("uint8array"),
            zip.file(firmwareFile.name).async("uint8array"),
            zip.file(partitionsFile.name).async("uint8array")
        ]);
    });
};

const convertToFlashFiles = (files: any[]) => {
    if (files?.length != 4) {
        throw new Error("Could not extract files from package");
    }
    return [
        {
            fileName: "Bootloader",
            data: convertUint8ArrayToBinaryString(files[0]),
            address: parseInt("0x1000")
        },
        {
            fileName: "Boot app",
            data: convertUint8ArrayToBinaryString(files[1]),
            address: parseInt("0xe000")
        },
        {
            fileName: "Firmware",
            data: convertUint8ArrayToBinaryString(files[2]),
            address: parseInt("0x10000")
        },
        {
            fileName: "Partitions",
            data: convertUint8ArrayToBinaryString(files[3]),
            address: parseInt("0x8000")
        }
    ];
};

export const InstallService = {
    installRelease: async (
        release: GithubRelease,
        serialPort: SerialPort,
        firmwareType: FirmwareType,
        onProgress: (FlashProgress) => void,
        onState: (state: InstallerState) => void
    ): Promise<void> => {
        const asset = GithubService.getReleaseAsset(release);

        let zipData: Blob | undefined = undefined;
        try {
            onState(InstallerState.DOWNLOADING);
            zipData = await GithubService.getReleaseAssetZip(asset!);
        } catch (error) {
            console.error(error);
            onState(InstallerState.ERROR);
            throw "Could not download package";
        }

        let files: any[] | undefined;
        try {
            onState(InstallerState.EXTRACTING);
            files = await unzipAssetData(zipData, firmwareType);
        } catch (error) {
            console.error(error);
            onState(InstallerState.ERROR);
            throw "Could not unzip package, it seems corrupted";
        }

        try {
            onState(InstallerState.FLASHING);
            const flashFiles = convertToFlashFiles(files!);
            await flashDevice(serialPort, flashFiles, onProgress);
            onState(InstallerState.DONE);
        } catch (error) {
            console.error(error);
            onState(InstallerState.ERROR);
            throw "Was not able to flash device";
        }

        return Promise.resolve();
    }
};
