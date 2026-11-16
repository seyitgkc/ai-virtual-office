/**
 * Start the stand-in services on this machine, for working on the office
 * without containers. Run: npm run services
 *
 * Then start the office with these set, and the demo office connects to them:
 *   DEMO_STOREFRONT_URL=http://127.0.0.1:8081
 *   DEMO_CARRIER_URL=http://127.0.0.1:8082
 *   DEMO_LEDGER_URL=http://127.0.0.1:8083
 *   DEMO_SUPPLIER_URL=http://127.0.0.1:8084
 *   DEMO_SERVICE_DESK_URL=http://127.0.0.1:8085
 *   DEMO_SYSTEMS_KEY=local-systems-key
 */
import { carrier } from "../services/carrier/server.ts";
import { ledger } from "../services/ledger/server.ts";
import { serviceDesk } from "../services/service-desk/server.ts";
import { storefront } from "../services/storefront/server.ts";
import { supplier } from "../services/supplier/server.ts";

const key = process.env.DEMO_SYSTEMS_KEY ?? "local-systems-key";
const services = [
  ["storefront", storefront, 8081],
  ["carrier", carrier, 8082],
  ["ledger", ledger, 8083],
  ["supplier", supplier, 8084],
  ["service desk", serviceDesk, 8085],
] as const;
for (const [name, build, port] of services) {
  build(key).listen(port, "127.0.0.1", () => console.log(`${name} on http://127.0.0.1:${port}`));
}
