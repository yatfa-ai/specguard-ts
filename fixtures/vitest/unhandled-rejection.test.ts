// A passing test that leaves a rejected promise floating: Vitest reports an
// Unhandled Rejection (several errors in one file must still be ONE row).
import { test } from "vitest";

test("floats a rejection", async () => {
  void Promise.reject(new Error("floating rejection one"));
  void Promise.reject(new Error("floating rejection two"));
  await new Promise((resolve) => setTimeout(resolve, 50));
});
