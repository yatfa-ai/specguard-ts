// A file whose own test fails AND that leaks a throwing timer: the failed
// test is the file's one failed row, the unhandled error adds nothing.
import { test } from "vitest";

test("fails itself", async () => {
  setTimeout(() => {
    throw new Error("leaked timer boom in failing file");
  }, 5);
  await new Promise((resolve) => setTimeout(resolve, 50));
  throw new Error("test failure");
});
