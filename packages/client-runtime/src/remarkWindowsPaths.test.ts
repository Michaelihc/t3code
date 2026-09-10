import { describe, expect, it } from "vite-plus/test";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { remarkWindowsPaths } from "./remarkWindowsPaths.ts";

const processor = unified().use(remarkParse).use(remarkWindowsPaths);

describe("Windows Markdown destinations", () => {
  it.each([
    String.raw`![shop](C:\Users\Michael\repo\.server\brand\shop.png)`,
    String.raw`[shop](C:\Users\Michael\repo\.server\brand\shop.png)`,
    String.raw`[shop]: C:\Users\Michael\repo\.server\brand\shop.png`,
  ])("preserves the hidden-directory separator in %s", (markdown) => {
    const tree = processor.parse(markdown);
    const node = tree.children[0];
    const destination = node?.type === "paragraph" ? node.children[0] : node;
    expect(destination).toMatchObject({ url: "C:/Users/Michael/repo/.server/brand/shop.png" });
  });

  it("preserves spaces, punctuation-prefixed directories, entities and titles", () => {
    const tree = processor.parse(
      String.raw`![image](<C:\My Project\_assets\#previews\a&amp;b.png> "Preview")`,
    );
    expect(tree.children[0]).toMatchObject({
      children: [{ url: "C:/My Project/_assets/#previews/a&b.png", title: "Preview" }],
    });
  });

  it("accepts already escaped Windows separators", () => {
    expect(
      processor.parse(String.raw`![image](C:\\repo\\.server\\image.png)`).children[0],
    ).toMatchObject({ children: [{ url: "C:/repo/.server/image.png" }] });
  });

  it.each([
    String.raw`![image](https://example.com/a\(1\).png "Title")`,
    String.raw`![image](C:/repo/a\(1\).png)`,
    String.raw`[file](../a\_b.md)`,
    String.raw`[file]: /tmp/a&amp;b.md`,
    "`![image](C:\\repo\\.server\\image.png)`",
    "```md\n![image](C:\\repo\\.server\\image.png)\n```",
  ])("keeps ordinary Markdown semantics for %s", (markdown) => {
    expect(processor.parse(markdown)).toEqual(unified().use(remarkParse).parse(markdown));
  });
});
