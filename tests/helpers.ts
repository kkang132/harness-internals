// Shared test helper: a fresh mock customer system on a random localhost port, closed after use.

import { CustomerSystem, type Faults } from "../src/customer-system/server.ts";
import { newSession } from "../src/harness/session.ts";
import type { ToolContext } from "../src/harness/tools.ts";
import { Trace } from "../src/harness/trace.ts";

export async function withSystem(
  faults: Faults,
  customerId: string,
  fn: (ctx: ToolContext, sys: CustomerSystem) => Promise<void>,
): Promise<void> {
  const sys = new CustomerSystem(undefined, faults);
  const srv = await sys.listen();
  try {
    await fn({ session: newSession(customerId), apiUrl: srv.url, trace: new Trace() }, sys);
  } finally {
    await srv.close();
  }
}
