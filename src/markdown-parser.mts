export interface MarkdownHeading {
  level: number;
  text: string;
  line: number;
}

export interface MarkdownCodeBlock {
  language: string;
  infoString: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface MarkdownProseLine {
  line: number;
  text: string;
}

export interface MarkdownLink {
  target: string;
  line: number;
  column: number;
}

export interface MarkdownParseError {
  message: string;
}

export interface MarkdownDocument {
  lines: string[];
  headings: MarkdownHeading[];
  codeBlocks: MarkdownCodeBlock[];
  proseLines: MarkdownProseLine[];
  links: MarkdownLink[];
  errors: MarkdownParseError[];
}

interface OpenMarkdownFence {
  indent: string;
  marker: string;
  length: number;
  infoString: string;
  startLine: number;
  contentLines: string[];
}

export function parseMarkdown(content: unknown): MarkdownDocument {
  const lines = String(content || "").split(/\r?\n/);
  const headings: MarkdownHeading[] = [];
  const codeBlocks: MarkdownCodeBlock[] = [];
  const proseLines: MarkdownProseLine[] = [];
  const links: MarkdownLink[] = [];
  const errors: MarkdownParseError[] = [];
  let fence: OpenMarkdownFence | null = null;

  for (const [offset, line] of lines.entries()) {
    const lineNumber = offset + 1;
    if (!fence) {
      const opening = line.match(/^([ \t]*)(`{3,}|~{3,})(.*)$/);
      if (opening) {
        fence = {
          indent: opening[1], marker: opening[2][0], length: opening[2].length,
          infoString: opening[3].trim(), startLine: lineNumber, contentLines: [],
        };
        continue;
      }
      const heading = line.match(/^[ \t]{0,3}(#{1,6})(?:[ \t]+|$)(.*)$/);
      if (heading) {
        const text = heading[2].replace(/[ \t]+#+[ \t]*$/, "").trim();
        if (text) headings.push({ level: heading[1].length, text, line: lineNumber });
      }
      for (const match of line.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        links.push({ target: match[1], line: lineNumber, column: match.index + 1 });
      }
      proseLines.push({ line: lineNumber, text: line });
      continue;
    }

    const closing = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*$/);
    if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) {
      const language = fence.infoString.split(/\s+/).filter(Boolean)[0] || "";
      codeBlocks.push({ language, infoString: fence.infoString, startLine: fence.startLine, endLine: lineNumber, content: fence.contentLines.join("\n") });
      fence = null;
    } else {
      fence.contentLines.push(fence.indent && line.startsWith(fence.indent) ? line.slice(fence.indent.length) : line);
    }
  }
  if (fence) errors.push({ message: `unclosed Markdown fence starting at line ${fence.startLine}` });
  return { lines, headings, codeBlocks, proseLines, links, errors };
}
