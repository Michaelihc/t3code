import { decodeString } from "micromark-util-decode-string";
import type { Token } from "micromark-util-types";
import type { Processor } from "unified";

interface DestinationContext {
  resume(): string;
  sliceSerialize(token: Token): string;
  stack: { type: string; url?: string }[];
}

function exitDestination(this: DestinationContext, token: Token) {
  const decoded = this.resume();
  const source = this.sliceSerialize(token);
  const node = this.stack.at(-1);
  if (!node) return;

  // Read the destination token before Markdown's escapes erase separators in
  // paths such as C:\repo\.server\image.png. Forward-slash paths keep normal
  // Markdown escaping, including escaped parentheses in filenames.
  node.url = /^[a-z]:\\/i.test(source) ? decodeString(source.replace(/\\+/g, "/")) : decoded;
}

/** Preserve backslash-style Windows destinations in links, images and definitions. */
function attachWindowsPaths(this: Processor) {
  const data = this.data();
  const extensions = data.fromMarkdownExtensions ?? (data.fromMarkdownExtensions = []);
  extensions.push({
    exit: {
      resourceDestinationString: exitDestination,
      definitionDestinationString: exitDestination,
    },
  });
}

export const remarkWindowsPaths = attachWindowsPaths;
