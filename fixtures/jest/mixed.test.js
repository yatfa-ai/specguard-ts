// Line numbers here are load-bearing: test/integration.jest.test.ts asserts
// line_number for each of these tests (and the coordinates fixture asserts
// the anchor of `location.line`). If you move anything, update that test.

describe("passing suite", () => {
  it("child ok", async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(true).toBe(true);
  });

  describe("inner suite", () => {
    it("grandchild ok", () => {
      expect(true).toBe(true);
    });
  });

  it("child failing", () => {
    expect(1).toBe(2);
  });

  it.skip("child skipped", () => {});

  it.todo("child todo");
});

it("top level ok", () => {
  expect(true).toBe(true);
});
