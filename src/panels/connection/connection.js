import { useContext, useState } from "react";
import { AppContext } from "../../app";
import Status from "../../model/status";
import * as classes from "./connection.module.css";

const connectImageUrl = new URL("../../assets/connect.svg", import.meta.url);

const Connection = ({ onConnect }) => {
  const { baudRate, setBaudRate, chip, status} =
    useContext(AppContext);
  const { showAdvanced, setShowAdvanced } = useState(false);

  return (
    <>
      {(status === Status.DISCONNECTED || status === Status.CONNECTING) && (
        <>
          <h2>FluidNC Web Installer</h2>
          <p>This tool will make it easy to install or upgrade FluidNC on your controller.<br/>Plug in your controller and press Connect to continue.</p>
          <p><img className={classes.image} src={connectImageUrl} alt="Connect" /></p>
        </>
      )}


      {status !== Status.CONNECTED && showAdvanced && (
        <div>
          <label className="col-sm-2 col-form-label">Baudrate:</label>
          <select
            className="form-select"
            value={baudRate}
            onChange={(event) => setBaudRate(event.value)}
          >
            <option value="921600">921600</option>
            <option value="460800">460800</option>
            <option value="230400">230400</option>
            <option value="115200">115200</option>
          </select>
        </div>
      )}

      {status !== Status.CONNECTED && (
        <button
          className="btn btn-primary btn-lg"
          type="button"
          onClick={onConnect}
          disabled={status === Status.CONNECTING}
        >
          {status === Status.CONNECTING && (
            <>
              <span
                className="spinner-border spinner-border-sm"
                role="status"
                aria-hidden="true"
              />{" "}
              Connecting
            </>
          )}
          {status === Status.DISCONNECTED && "Connect"}
        </button>
      )}
    </>
  );
};
export default Connection;
