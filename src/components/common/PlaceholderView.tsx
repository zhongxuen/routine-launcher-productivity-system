interface PlaceholderViewProps {
  title: string;
}

/**
 * Generic stub used by every not-yet-implemented view.
 * Later prompts will replace individual usages with real components.
 */
function PlaceholderView({ title }: PlaceholderViewProps) {
  return (
    <div className="flex flex-col gap-1 py-10">
      <h2 className="text-base font-medium">{title}</h2>
      <p className="text-sm text-muted-foreground">This view has not been implemented yet.</p>
    </div>
  );
}

export default PlaceholderView;
