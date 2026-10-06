import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JsonDetail } from "./JsonDetail";

describe("JsonDetail", () => {
  it("renders tool-controlled payloads as text", () => {
    const payload = { output: "</pre><script>globalThis.pwned = true</script>" };
    render(<JsonDetail value={payload} />);

    expect(screen.getByText(/globalThis\.pwned/)).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
  });
});
