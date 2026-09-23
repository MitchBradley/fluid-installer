import React, { useMemo } from "react";
import { Routes, Route, useNavigate } from "react-router-dom";
import { Container } from "react-bootstrap";
import { Header } from "./components";
import Page from "./model/Page";
import FileBrowser from "./pages/fluidnc/filebrowser";
import Home from "./pages/fluidnc/home";
import { isSafari, isFirefox } from "./utils/utils";

import WiFiSettings from "./pages/fluidnc/wifisettings/WiFiSettings";
import Calibrate from "./pages/fluidnc/calibrate/Calibrate";
import Footer from "./components/footer/Footer";
import Unsupported from "./panels/unsupported/Unsupported";

import MatomoTracker from "./components/matomotracker/MatomoTracker";
import FluidNCOutlet from "./outlets/FluidNCOutlet";
import SelectDevicePage from "./pages/selectdevice/SelectDevicePage";
import FluidDialOutlet from "./outlets/FluidDialOutlet";
import FluidDialHomePage from "./pages/fluiddial/home/HomePage";
import Installer from "./pages/fluidnc/installer";
import Terminal from "./pages/fluidnc/terminal";
import StackTraceDecoder from "./pages/fluidnc/stacktracedecoder";
import NotFoundPage from "./pages/notfound/NotFoundPage";
import { GithubService } from "./services";
import { ConfigValidation } from "./pages/configvalidation/ConfigValidation";

const Root = () => {
    const navigate = useNavigate();
    // TEMP: local testing of the PSRAM manifest changes against a
    // provisional manifest.json (see /tmp scratch release-test-server),
    // without touching the real fluidnc-releases mirror repo. Revert
    // before committing.
    const githubService = useMemo(
        () => new GithubService(undefined, "http://127.0.0.1:8899"),
        []
    );

    if (isSafari() || isFirefox()) {
        return <Unsupported />;
    }

    return (
        <Routes>
            <Route index element={<SelectDevicePage />} />
            <Route path={Page.FLUIDNC_HOME} element={<FluidNCOutlet />}>
                <Route index element={<Home />} />
                <Route
                    path={Page.FLUIDNC_INSTALLER}
                    element={
                        <Installer
                            onClose={() => navigate(Page.FLUIDNC_HOME)}
                            githubService={githubService}
                        />
                    }
                />
                <Route path={Page.FLUIDNC_TERMINAL} element={<Terminal />} />
                <Route
                    path={Page.FLUIDNC_FILEBROWSER}
                    element={<FileBrowser />}
                />
                <Route path={Page.FLUIDNC_WIFI} element={<WiFiSettings />} />
                <Route path={Page.FLUIDNC_CALIBRATE} element={<Calibrate />} />
                <Route
                    path={Page.FLUIDNC_STACKTRACE_DECODER}
                    element={<StackTraceDecoder />}
                />
            </Route>
            <Route path={Page.FLUID_DIAL_HOME} element={<FluidDialOutlet />}>
                <Route index element={<FluidDialHomePage />} />
            </Route>
            <Route
                path={Page.FLUIDNC_CONFIG_VALIDATION}
                element={<ConfigValidation />}
            />

            <Route path="*" element={<NotFoundPage />} />
        </Routes>
    );
};

const App = () => {
    return (
        <MatomoTracker>
            <Header />
            <Container>
                <Root />
            </Container>
            <Footer />
        </MatomoTracker>
    );
};

export default App;
