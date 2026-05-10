import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Bold,
  Heading1,
  Heading2,
  Italic,
  List,
  ListOrdered,
  Quote,
  Type,
} from "lucide-react";

interface VisualMarkdownEditorProps {
  value: string;
  onChange(value: string): void;
  placeholder?: string;
}

type FormatCommand =
  | { command: "bold" | "italic" | "insertUnorderedList" | "insertOrderedList" }
  | { command: "formatBlock"; value: "p" | "h1" | "h2" | "blockquote" };

export function VisualMarkdownEditor({
  value,
  onChange,
  placeholder = "Start writing...",
}: VisualMarkdownEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const lastAppliedValueRef = useRef<string | null>(null);
  const [empty, setEmpty] = useState(value.trim().length === 0);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (lastAppliedValueRef.current === value) return;
    if (document.activeElement === editor) return;

    editor.innerHTML = markdownToVisualHtml(value);
    lastAppliedValueRef.current = value;
    setEmpty(value.trim().length === 0);
  }, [value]);

  function emitChange() {
    const editor = editorRef.current;
    if (!editor) return;
    const next = visualHtmlToMarkdown(editor);
    lastAppliedValueRef.current = next;
    setEmpty(next.trim().length === 0);
    onChange(next);
  }

  function applyFormat(format: FormatCommand) {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    if (format.command === "formatBlock") {
      document.execCommand(format.command, false, format.value);
    } else {
      document.execCommand(format.command);
    }
    emitChange();
  }

  return (
    <div className="visual-markdown-editor">
      <div className="visual-markdown-toolbar" aria-label="Visual formatting">
        <ToolbarButton
          label="Paragraph"
          onClick={() => applyFormat({ command: "formatBlock", value: "p" })}
        >
          <Type size={15} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="Heading 1"
          onClick={() => applyFormat({ command: "formatBlock", value: "h1" })}
        >
          <Heading1 size={15} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="Heading 2"
          onClick={() => applyFormat({ command: "formatBlock", value: "h2" })}
        >
          <Heading2 size={15} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton label="Bold" onClick={() => applyFormat({ command: "bold" })}>
          <Bold size={15} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton label="Italic" onClick={() => applyFormat({ command: "italic" })}>
          <Italic size={15} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="Bulleted list"
          onClick={() => applyFormat({ command: "insertUnorderedList" })}
        >
          <List size={15} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="Numbered list"
          onClick={() => applyFormat({ command: "insertOrderedList" })}
        >
          <ListOrdered size={15} aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton
          label="Quote"
          onClick={() => applyFormat({ command: "formatBlock", value: "blockquote" })}
        >
          <Quote size={15} aria-hidden="true" />
        </ToolbarButton>
      </div>
      <div
        ref={editorRef}
        aria-label="Visual markdown editor"
        aria-multiline="true"
        className="visual-markdown-surface markdown-preview-rendered markdown-body"
        contentEditable
        data-empty={empty ? "true" : "false"}
        data-placeholder={placeholder}
        onBlur={emitChange}
        onInput={emitChange}
        role="textbox"
        suppressContentEditableWarning
      />
    </div>
  );
}

function ToolbarButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className="visual-markdown-toolbar-button"
      onClick={onClick}
      onMouseDown={(event) => event.preventDefault()}
      title={label}
    >
      {children}
    </button>
  );
}

export function markdownToVisualHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  const paragraph: string[] = [];
  let i = 0;

  const flushParagraph = () => {
    const text = paragraph.join("\n").trim();
    paragraph.length = 0;
    if (text) html.push(`<p>${inlineMarkdownToHtml(text)}</p>`);
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line.trim())) {
      flushParagraph();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdownToHtml(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph();
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      html.push(`<blockquote><p>${inlineMarkdownToHtml(quoteLines.join("\n"))}</p></blockquote>`);
      continue;
    }

    const unordered = /^\s*[-*]\s+(.+)$/.exec(line);
    if (unordered) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length) {
        const item = /^\s*[-*]\s+(.+)$/.exec(lines[i]);
        if (!item) break;
        items.push(`<li>${inlineMarkdownToHtml(item[1])}</li>`);
        i += 1;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    const ordered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (ordered) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length) {
        const item = /^\s*\d+\.\s+(.+)$/.exec(lines[i]);
        if (!item) break;
        items.push(`<li>${inlineMarkdownToHtml(item[1])}</li>`);
        i += 1;
      }
      html.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    paragraph.push(line);
    i += 1;
  }

  flushParagraph();
  return html.join("");
}

export function visualHtmlToMarkdown(root: HTMLElement): string {
  const blocks = Array.from(root.childNodes)
    .map((node) => blockNodeToMarkdown(node))
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n");
}

function blockNodeToMarkdown(node: ChildNode): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement)) return "";

  const tag = node.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    return `${"#".repeat(level)} ${inlineNodesToMarkdown(node.childNodes)}`;
  }
  if (tag === "ul") {
    return Array.from(node.children)
      .filter((child) => child.tagName.toLowerCase() === "li")
      .map((child) => `- ${inlineNodesToMarkdown(child.childNodes).replace(/\n/g, "\n  ")}`)
      .join("\n");
  }
  if (tag === "ol") {
    return Array.from(node.children)
      .filter((child) => child.tagName.toLowerCase() === "li")
      .map((child, index) => `${index + 1}. ${inlineNodesToMarkdown(child.childNodes).replace(/\n/g, "\n   ")}`)
      .join("\n");
  }
  if (tag === "blockquote") {
    const inner = Array.from(node.childNodes)
      .map((child) => blockNodeToMarkdown(child))
      .join("\n\n")
      .trim();
    return inner
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }
  if (tag === "pre") {
    return `\`\`\`\n${node.textContent?.trimEnd() ?? ""}\n\`\`\``;
  }
  if (tag === "br") return "";

  return inlineNodesToMarkdown(node.childNodes);
}

function inlineNodesToMarkdown(nodes: NodeListOf<ChildNode>): string {
  return Array.from(nodes).map(inlineNodeToMarkdown).join("");
}

function inlineNodeToMarkdown(node: ChildNode): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement)) return "";

  const tag = node.tagName.toLowerCase();
  if (tag === "strong" || tag === "b") return `**${inlineNodesToMarkdown(node.childNodes)}**`;
  if (tag === "em" || tag === "i") return `*${inlineNodesToMarkdown(node.childNodes)}*`;
  if (tag === "code") return `\`${node.textContent ?? ""}\``;
  if (tag === "a") {
    const label = inlineNodesToMarkdown(node.childNodes) || node.getAttribute("href") || "";
    const href = node.getAttribute("href") ?? "";
    return href ? `[${label}](${href})` : label;
  }
  if (tag === "br") return "\n";
  if (tag === "div" || tag === "p") return `${inlineNodesToMarkdown(node.childNodes)}\n`;
  return inlineNodesToMarkdown(node.childNodes);
}

function inlineMarkdownToHtml(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_match, label: string, href: string) =>
        `<a href="${escapeAttribute(href)}">${label}</a>`
    )
    .replace(/\n/g, "<br />");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
