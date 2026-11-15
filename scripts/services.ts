/**
 * Start the two stand-in services on this machine, for working on the office
 * without containers. Run: npm run services
 *
 * Then start the office with these set, and the demo office connects to them:
 *   DEMO_STOREFRONT_URL=http://127.0.0.1:8081
 *   DEMO_CARRIER_URL=http://127.0.0.1:8082
 *   DEMO_SYSTEMS_KEY=local-systems-key
 */
import { carrier } from "../services/carrier/server";
import { storefront } from "../services/storefront/server";

const key = process.env.DEMO_SYSTEMS_KEY ?? "local-systems-key";
storefront(key).listen(8081, "127.0.0.1", () => console.log("storefront on http://127.0.0.1:8081"));
carrier(key).listen(8082, "127.0.0.1", () => console.log("carrier on http://127.0.0.1:8082"));
