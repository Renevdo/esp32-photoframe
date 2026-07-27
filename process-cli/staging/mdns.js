/**
 * mDNS advertisement so the companion app discovers the staging server as a
 * photo frame (_esp32-pframe._tcp, TXT records in the device format from
 * main/mdns_service.c). Never claims the real device hostname.
 */

import os from "os";
import { Bonjour } from "bonjour-service";

// TXT host for the virtual frame. Guard against a machine that is itself
// named "photoframe": the proxy must never claim the real device identity.
export function stagingHost(rawHostname) {
  let name = rawHostname.replace(/\.local$/i, "");
  if (name.toLowerCase() === "photoframe") {
    name = `${name}-staging`;
  }
  return `${name}.local`;
}

export function advertise({ port, instanceName, board, version }) {
  const bonjour = new Bonjour();
  const host = stagingHost(os.hostname());

  const service = bonjour.publish({
    name: instanceName,
    type: "esp32-pframe",
    protocol: "tcp",
    port,
    txt: {
      name: instanceName,
      host,
      board: board || "virtual",
      version: version || "staging",
    },
  });

  return {
    stop() {
      return new Promise((resolve) => {
        service.stop(() => {
          bonjour.destroy();
          resolve();
        });
      });
    },
  };
}
