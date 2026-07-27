/**
 * mDNS advertisement so the companion app discovers the staging server as a
 * photo frame (_esp32-pframe._tcp, TXT records in the device format from
 * main/mdns_service.c). Never claims the real device hostname.
 */

import os from "os";
import { Bonjour } from "bonjour-service";

export function advertise({ port, instanceName, board, version }) {
  const bonjour = new Bonjour();
  const host = `${os.hostname().replace(/\.local$/i, "")}.local`;

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
