import React, { useEffect, useMemo, useState, useContext } from "react";
import { useTranslation } from "react-i18next";
import { Spinner } from "../../components";
import {
    FirmwareChoice,
    GithubRelease,
    GithubReleaseManifest,
    GithubService
} from "../../services/GitHubService";
import "./Firmware.scss";
import Choice from "../../components/choice";
import PageTitle from "../../components/pagetitle/PageTitle";
import FirmwareBreadCrumbList from "./FirmwareBreadcrumbList";
import {
    Col,
    FormCheck,
    Row,
    Form,
    DropdownButton,
    Dropdown
} from "react-bootstrap";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import UploadCustomImageModal from "../../modals/installermodal/UploadCustomImageModal";
import VersionCard from "../../components/cards/versioncard/VersionCard";
import { SerialPortContext } from "../../context/SerialPortContext";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
    faWarning,
    faFileArrowUp,
    faSliders
} from "@fortawesome/free-solid-svg-icons";
import { Alert } from "react-bootstrap";

type Props = {
    onInstall: (
        release: GithubRelease,
        manifest: GithubReleaseManifest,
        choice: FirmwareChoice
    ) => void;
    githubService: GithubService;
};

const Firmware = ({ onInstall, githubService }: Props) => {
    const { t } = useTranslation();
    const [selectedChoices, setSelectedChoices] = useState<FirmwareChoice[]>(
        []
    );
    const [releases, setReleases] = useState<GithubRelease[]>([]);
    const [uploadCustomImage, setUploadCustomImage] = useState<boolean>(false);
    const [selectedRelease, setSelectedRelease] = useState<GithubRelease>();
    const [errorMessage, setErrorMessage] = useState<string | undefined>();
    const [warningMessage, setWarningMessage] = useState<string | undefined>();
    const [unsupportedMessage, setUnsupportedMessage] = useState<
        string | undefined
    >();
    const [releaseManifest, setReleaseManifest] = useState<
        GithubReleaseManifest | undefined
    >();
    const [showPrerelease, setShowPrerelease] = useLocalStorage(
        "showPrerelease",
        false
    );
    const [isDetecting, setIsDetecting] = useState<boolean>(true);
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [mcu, setMcu] = useState<string | undefined>(undefined);
    const [psram, setPsram] = useState<"none" | "quad" | "octal" | undefined>(
        undefined
    );
    const [showAllPsramChoices, setShowAllPsramChoices] =
        useState<boolean>(false);

    const serialPort = useContext(SerialPortContext);

    const chooseMcu = () => {
        if (
            mcu &&
            selectedChoices.length == 1 &&
            selectedChoices[0]["choice-name"] == "Processor type"
        ) {
            for (const mcuentry of selectedChoices[0].choices) {
                if (mcuentry.name === mcu) {
                    setSelectedChoices((choices) => [...choices, mcuentry]);
                    setUnsupportedMessage("");
                    return;
                }
            }
            setUnsupportedMessage("This release does not support " + mcu);
        }
    };

    const choice = useMemo(() => {
        chooseMcu();
        return selectedChoices[selectedChoices.length - 1];
    }, [selectedChoices]);

    // The level right under an MCU (e.g. esp32s3) lists firmware variants
    // (wifi, wifi-octalpsram, noradio, ...), each carrying the list of
    // detected-PSRAM values it should be offered for (compatible_psram --
    // e.g. the Quad-PSRAM "wifi" build lists all three, since it still
    // runs fine, just without PSRAM, on none/Octal modules; the Octal-only
    // build lists just "octal"). This is an *inclusion* filter, not a
    // narrow-to-one-match: a module can (and for Octal modules, normally
    // will) have more than one compatible variant, letting the user choose
    // between "plain, always works" and "enables PSRAM, but don't pick
    // this if you use GPIO 33-37 for something else" (see that variant's
    // description). All policy here comes from manifest data; nothing
    // about which variant suits which PSRAM type is hardcoded.
    //
    // Filtering only applies once the board's actual PSRAM is known (from
    // efuse, read alongside the MCU) and every entry at this level
    // actually carries a compatible_psram list, and only until the user
    // asks to see the rest -- detection can be wrong (it only sees
    // *embedded* PSRAM, not an external chip on a custom board) or
    // inconclusive (engineering-sample efuses, chips esptool-js doesn't
    // support). If filtering would leave nothing to show (shouldn't
    // happen given the manifest is expected to always keep a
    // universally-compatible variant, but data could be wrong), fall back
    // to showing everything rather than stranding the user.
    const psramFilterAvailable =
        psram !== undefined &&
        !!choice?.choices?.length &&
        choice.choices.every((c) => Array.isArray(c.compatible_psram));
    const psramFilterActive = psramFilterAvailable && !showAllPsramChoices;
    const displayedChoice = useMemo(() => {
        if (!choice || !psramFilterActive) {
            return choice;
        }
        const filtered = choice.choices.filter((c) =>
            c.compatible_psram!.includes(psram!)
        );
        if (!filtered.length) {
            return choice;
        }
        return { ...choice, choices: filtered };
    }, [choice, psramFilterActive, psram]);

    useEffect(() => {
        // A fresh navigation into a different choice level should re-arm
        // the filter rather than carry over an override from a previous
        // (unrelated) screen.
        setShowAllPsramChoices(false);
    }, [choice]);
    const chooseFirmware = (id) => {
        const release = releases.find((r) => r.id + "" === id + "");
        setSelectedRelease(release);

        if (release) {
            setIsLoading(true);
            githubService
                .getReleaseManifest(release)
                .then((manifest) => {
                    setReleaseManifest(manifest);
                    setSelectedChoices([manifest.installable]);
                })
                .catch((error) => {
                    setErrorMessage(
                        "Could not download the release asset " + error
                    );
                })
                .finally(() => setIsLoading(false));
        }
    };

    const fetchReleases = () => {
        githubService
            .getReleases(showPrerelease === "true")
            .then((releases) => {
                setReleases(releases);
            })
            .catch((error) => {
                console.error(error);
                setErrorMessage(
                    "Could not download releases, please try again later"
                );
            });
    };

    const onSelect = (choice: FirmwareChoice) => {
        if (choice.images) {
            onInstall(selectedRelease!, releaseManifest!, choice);
        } else {
            setSelectedChoices((choices) => [...choices, choice]);
        }
    };

    // The key is the MCU name returned by esploader.
    // The value is the corresponding name in FluidNC manifests
    const mcuMap = new Map<string, string>([
        ["ESP32-S3", "esp32s3"],
        ["ESP32", "esp32"]
    ]);

    useEffect(() => {
        const getMcu = async (): string => {
            setIsDetecting(true);
            await serialPort
                .getInfo()
                .then((result) => {
                    setMcu(mcuMap.get(result.mcu));
                    setPsram(result.psram);
                })
                .catch((error) => {
                    console.log("Cannot get MCU:" + error);
                    setWarningMessage(
                        "Could not determine the MCU type.  Choose it manually."
                    );
                })
                .finally(() => {
                    setIsDetecting(false);
                });
        };
        if (mcu === undefined) {
            getMcu();
        }
    }, []);

    useEffect(() => {
        chooseMcu();
    }, [mcu]);

    useEffect(() => {
        if (releases && releases.length) {
            chooseFirmware(releases[0].id);
        }
    }, [releases]);

    useEffect(() => fetchReleases(), [showPrerelease]);

    return (
        <div className="firmware-component">
            {errorMessage && (
                <Alert variant="danger">
                    <FontAwesomeIcon
                        color="danger"
                        icon={faWarning as IconDefinition}
                        size="lg"
                    />{" "}
                    {errorMessage}
                </Alert>
            )}

            {uploadCustomImage && (
                <UploadCustomImageModal
                    onClose={() => setUploadCustomImage(false)}
                />
            )}

            {isDetecting && <PageTitle>{"Getting MCU Type ..."}</PageTitle>}

            {!isDetecting && !errorMessage && (
                <>
                    <PageTitle>
                        {t("panel.firmware.install") +
                            (mcu ? " on " + mcu : "")}
                    </PageTitle>
                    <p>{t("panel.firmware.install-description")}</p>

                    <Row>
                        <Col sm="12" md="12" lg="9" xl="8">
                            <Row>
                                <Col>
                                    <Form.Select
                                        size="lg"
                                        onChange={(event) =>
                                            chooseFirmware(event.target.value)
                                        }
                                    >
                                        {!releases?.length && (
                                            <option>
                                                {t("panel.firmware.loading")}
                                            </option>
                                        )}
                                        {releases.map((release) => (
                                            <option
                                                key={release.id}
                                                value={release.id}
                                            >
                                                {release.name}
                                            </option>
                                        ))}
                                    </Form.Select>
                                </Col>
                                <Col
                                    xs="3"
                                    sm="3"
                                    md="2"
                                    lg="2"
                                    style={{ paddingLeft: 0 }}
                                >
                                    <DropdownButton
                                        variant="outline"
                                        className={"d-grid"}
                                        size="lg"
                                        title={
                                            <FontAwesomeIcon
                                                icon={
                                                    faSliders as IconDefinition
                                                }
                                            />
                                        }
                                    >
                                        <Dropdown.Item
                                            onClick={() =>
                                                setShowPrerelease(
                                                    (
                                                        showPrerelease !==
                                                        "true"
                                                    ).toString()
                                                )
                                            }
                                        >
                                            {" "}
                                            <FormCheck
                                                type="switch"
                                                label={t(
                                                    "panel.firmware.show-prereleases"
                                                )}
                                                checked={
                                                    showPrerelease === "true"
                                                }
                                            />
                                        </Dropdown.Item>
                                        <Dropdown.Divider />
                                        <Dropdown.Item
                                            onClick={() =>
                                                setUploadCustomImage(true)
                                            }
                                        >
                                            <FontAwesomeIcon
                                                icon={
                                                    faFileArrowUp as IconDefinition
                                                }
                                            />
                                            {t(
                                                "panel.firmware.install-custom-image"
                                            )}
                                        </Dropdown.Item>
                                    </DropdownButton>
                                </Col>
                            </Row>
                        </Col>
                    </Row>
                </>
            )}

            {isLoading && (
                <Row style={{ marginTop: "40px" }}>
                    <Col sm="12" md="12" lg="9" xl="8">
                        {t("panel.firmware.fetching")} <Spinner />
                    </Col>
                </Row>
            )}

            {!isDetecting && !isLoading && selectedRelease && (
                <div>
                    <Row>
                        <Col
                            sm="12"
                            md="12"
                            lg="9"
                            xl="8"
                            style={{ marginTop: "40px" }}
                        >
                            <FirmwareBreadCrumbList
                                release={selectedRelease}
                                selectedChoices={selectedChoices}
                                setSelectedChoices={setSelectedChoices}
                            />
                            <hr />
                            {warningMessage && (
                                <Row>
                                    <Alert variant="warning">
                                        <FontAwesomeIcon
                                            icon={faWarning as IconDefinition}
                                            size="lg"
                                        />{" "}
                                        {warningMessage}
                                    </Alert>
                                </Row>
                            )}
                            {unsupportedMessage && (
                                <div className="alert alert-danger">
                                    {unsupportedMessage}
                                </div>
                            )}
                            {!unsupportedMessage && psramFilterActive && (
                                <Alert variant="info">
                                    Detected {psram} PSRAM &mdash; hiding
                                    firmware variants that aren&apos;t
                                    compatible with it.{" "}
                                    <Alert.Link
                                        onClick={() =>
                                            setShowAllPsramChoices(true)
                                        }
                                    >
                                        Show all variants
                                    </Alert.Link>
                                </Alert>
                            )}
                            {!unsupportedMessage &&
                                displayedChoice &&
                                releaseManifest &&
                                !displayedChoice.images && (
                                    <div>
                                        <Choice
                                            choice={displayedChoice}
                                            onSelect={onSelect}
                                        />
                                    </div>
                                )}
                        </Col>
                    </Row>
                    <Row>
                        <Col sm="12" md="12" lg="9" xl="8">
                            <VersionCard
                                release={selectedRelease}
                                isLatest={false}
                            />
                        </Col>
                    </Row>
                </div>
            )}
        </div>
    );
};

export default Firmware;
