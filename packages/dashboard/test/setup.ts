// Adds the jest-dom matchers (toBeInTheDocument, toHaveAttribute, …) to Vitest's
// expect, and resets the DOM/handlers between tests.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
