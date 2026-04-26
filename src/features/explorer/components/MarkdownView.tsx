import ReactCodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";

interface MarkdownViewProps {
  value: string;
  readOnly: boolean;
  onChange?: (value: string) => void;
  placeholder?: string;
  className?: string;
}

export function MarkdownView({
  value,
  readOnly,
  onChange,
  placeholder,
  className,
}: MarkdownViewProps) {
  const extensions = readOnly
    ? [markdown(), EditorState.readOnly.of(true)]
    : [markdown()];

  return (
    <ReactCodeMirror
      basicSetup={{ lineNumbers: false, foldGutter: false }}
      className={className}
      extensions={extensions}
      height="100%"
      onChange={onChange}
      placeholder={placeholder}
      value={value}
    />
  );
}
