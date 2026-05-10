import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

interface MarkdownRendererProps {
  children: string;
  allowHtml?: boolean;
  components?: Components;
}

export function MarkdownRenderer({
  allowHtml = true,
  components,
  children,
}: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={allowHtml ? [rehypeRaw, rehypeKatex] : [rehypeKatex]}
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
}
