import { describe, expect, it } from "vitest";
import { renderPreviewHtml, toPlainText } from "@/lib/email-markup";

/**
 * The custom email body is author-controlled text that goes out to customers.
 *
 * The design that makes it safe is ordering: the text is ESCAPED first, and
 * formatting is applied to the escaped result. Raw HTML therefore cannot
 * survive — there is no sanitiser to defeat, because nothing is ever trusted.
 * These tests pin that property, not merely the happy path.
 */

const html = (text: string) => renderPreviewHtml(text).join("");

describe("nothing author-supplied can become markup", () => {
  it("renders a script tag as visible text", () => {
    const out = html('<script>alert("x")</script>');
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain("&lt;script&gt;");
  });

  it("renders an event handler as visible text", () => {
    const out = html('<img src=x onerror="steal()">');
    expect(out).not.toMatch(/<img/i);
    expect(out).toContain("&lt;img");
    // The attribute survives only as escaped characters, never as an attribute.
    expect(out).not.toMatch(/<[^>]+onerror/i);
  });

  it("escapes quotes so an attribute cannot be broken out of", () => {
    const out = html('" onmouseover="x');
    expect(out).toContain("&quot;");
    expect(out).not.toMatch(/<[^>]+onmouseover/i);
  });

  it("leaves a bare ampersand and angle brackets harmless", () => {
    expect(html("A & B < C > D")).toContain("A &amp; B &lt; C &gt; D");
  });
});

describe("links are restricted to safe schemes", () => {
  it("renders http, https and mailto", () => {
    expect(html("[site](https://example.com)")).toContain('<a href="https://example.com">site</a>');
    expect(html("[site](http://example.com)")).toContain('<a href="http://example.com">site</a>');
    expect(html("[mail](mailto:a@b.test)")).toContain('<a href="mailto:a@b.test">mail</a>');
  });

  it("REFUSES javascript, data and other schemes, leaving them as text", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:x",
      "file:///etc/passwd",
      "//evil.test",
    ]) {
      const out = html(`[click](${href})`);
      expect(out, href).not.toMatch(/<a /);
      expect(out, href).toContain("[click]");
    }
  });

  it("does not let an escaped ampersand smuggle a scheme through", () => {
    const out = html("[x](https://example.com/?a=1&b=2)");
    expect(out).toMatch(/<a href="https:\/\/example\.com\/\?a=1&amp;b=2">/);
  });
});

describe("the supported formatting", () => {
  it("renders bold and italic", () => {
    expect(html("**strong** and *soft*")).toContain("<strong>strong</strong>");
    expect(html("**strong** and *soft*")).toContain("<em>soft</em>");
  });

  it("does not read bold as two italics", () => {
    const out = html("**both**");
    expect(out).toContain("<strong>both</strong>");
    expect(out).not.toContain("<em>");
  });

  it("renders bulleted and numbered lists, grouping adjacent items", () => {
    const bullets = html("- one\n- two");
    expect(bullets).toContain("<ul");
    expect((bullets.match(/<li/g) ?? []).length).toBe(2);

    const numbers = html("1. one\n2. two");
    expect(numbers).toContain("<ol");
    expect((numbers.match(/<li/g) ?? []).length).toBe(2);
  });

  it("keeps a bulleted and a numbered list separate", () => {
    const out = html("- a\n1. b");
    expect(out).toContain("<ul");
    expect(out).toContain("<ol");
  });

  it("splits paragraphs on a blank line and keeps single breaks", () => {
    const out = html("one\ntwo\n\nthree");
    expect((out.match(/<p/g) ?? []).length).toBe(2);
    expect(out).toContain("<br />");
  });

  it("renders plain text unchanged — existing drafts keep working", () => {
    // The whole reason storage did not have to change.
    const out = html("It's time for our bi-annual opportunity check-in.");
    expect(out).toContain("It&#39;s time for our bi-annual opportunity check-in.");
    expect(out).not.toMatch(/<(strong|em|ul|ol|a) /);
  });
});

describe("the plain-text alternative is readable", () => {
  it("removes markers rather than leaving punctuation", () => {
    expect(toPlainText("**bold** and *soft*")).toBe("bold and soft");
  });

  it("turns a link into label and url", () => {
    expect(toPlainText("[site](https://example.com)")).toBe("site (https://example.com)");
  });

  it("leaves an unsafe link untouched rather than presenting it as a link", () => {
    expect(toPlainText("[x](javascript:alert(1))")).toContain("[x](javascript:");
  });

  it("marks list items", () => {
    expect(toPlainText("- one\n- two")).toBe("• one\n• two");
    expect(toPlainText("1. one\n2. two")).toBe("1. one\n2. two");
  });
});
