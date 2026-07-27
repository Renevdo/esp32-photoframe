import { stagingHost } from "../staging/mdns.js";

test("normal hostnames pass through with .local", () => {
  expect(stagingHost("renes-macbook")).toBe("renes-macbook.local");
  expect(stagingHost("renes-macbook.local")).toBe("renes-macbook.local");
});

test("never claims the real device identity", () => {
  expect(stagingHost("photoframe")).toBe("photoframe-staging.local");
  expect(stagingHost("PhotoFrame.local")).toBe("PhotoFrame-staging.local");
});
