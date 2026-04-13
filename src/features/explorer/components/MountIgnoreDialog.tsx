export function MountIgnoreDialog({
  ignoreConfig,
  onChange
}: {
  ignoreConfig: string;
  onChange(value: string): void;
}) {
  return (
    <label className="field-stack" htmlFor="mount-ignore">
      <span className="field-label">Ignore config</span>
      <textarea
        id="mount-ignore"
        name="mountIgnoreConfig"
        onChange={(event) => onChange(event.target.value)}
        value={ignoreConfig}
      />
    </label>
  );
}
