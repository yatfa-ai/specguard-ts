// A passing test that leaks a timer which throws after the test has finished:
// every test is "passed" yet Vitest reports an Unhandled Error and exits 1.
import { test } from "vitest";

test("leaks a throwing timer", async () => {
  setTimeout(() => {
    throw new Error("leaked timer boom");
  }, 5);
  await new Promise((resolve) => setTimeout(resolve, 50));
});
