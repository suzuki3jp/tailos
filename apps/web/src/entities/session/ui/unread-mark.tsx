import { cn } from "@/shared/lib/cn";

/** A 6px dot marking a Session the reader has not seen. */
export function UnreadMark({ className }: { className?: string }) {
  return (
    <span className={cn("block size-1.5 rounded-full bg-unread", className)}>
      <span className="sr-only">Unread</span>
    </span>
  );
}
