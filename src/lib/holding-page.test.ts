import { describe, expect, it } from "vitest";
import { holdingPageHtml, isHoldingExempt } from "./holding-page";

describe("isHoldingExempt", () => {
  it("keeps confirmation links and the API live", () => {
    expect(isHoldingExempt("/verify")).toBe(true);
    expect(isHoldingExempt("/api/verify")).toBe(true);
    expect(isHoldingExempt("/api/submit")).toBe(true);
  });

  it("keeps moderation live", () => {
    expect(isHoldingExempt("/login")).toBe(true);
    expect(isHoldingExempt("/reset-password")).toBe(true);
    expect(isHoldingExempt("/admin")).toBe(true);
    expect(isHoldingExempt("/admin/about")).toBe(true);
    expect(isHoldingExempt("/artist/abc-123/edit")).toBe(true);
    expect(isHoldingExempt("/artist/abc-123/revise/")).toBe(true);
  });

  it("holds everything public", () => {
    expect(isHoldingExempt("/")).toBe(false);
    expect(isHoldingExempt("/about")).toBe(false);
    expect(isHoldingExempt("/submit")).toBe(false);
    expect(isHoldingExempt("/artist/abc-123")).toBe(false);
    expect(isHoldingExempt("/organisation/abc-123")).toBe(false);
    expect(isHoldingExempt("/administrator")).toBe(false);
    expect(isHoldingExempt("/artist/abc-123/editor")).toBe(false);
  });
});

describe("holdingPageHtml", () => {
  it("is a complete, script-free document", () => {
    const html = holdingPageHtml();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toContain("<script");
    expect(html).toContain("All");
    expect(html).toContain("Frequencies");
    expect(html).toContain("back shortly");
  });

  it("escapes a custom message", () => {
    const html = holdingPageHtml('Back <b>soon</b> & "thanks"');
    expect(html).toContain("Back &lt;b&gt;soon&lt;/b&gt; &amp; &quot;thanks&quot;");
    expect(html).not.toContain("<b>soon</b>");
  });

  it("falls back to the default line when the message is blank", () => {
    expect(holdingPageHtml("   ")).toContain("moving to a new name");
  });
});
