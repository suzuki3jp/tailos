"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { useState, type ComponentProps, type ReactNode } from "react";
import { cn } from "../../lib/cn";

const avatarVariants = cva(
  "relative flex shrink-0 rounded-full select-none after:absolute after:inset-0 after:rounded-full after:border after:border-border after:mix-blend-darken dark:after:mix-blend-lighten",
  {
    variants: {
      size: {
        sm: "size-6 text-xs",
        default: "size-8 text-sm",
        lg: "size-10 text-sm",
      },
    },
    defaultVariants: { size: "default" },
  },
);

type AvatarProps = Pick<ComponentProps<"img">, "alt" | "referrerPolicy"> &
  VariantProps<typeof avatarVariants> & {
    src?: string;
    fallback: ReactNode;
    className?: string;
  };

export function Avatar(props: AvatarProps) {
  return <AvatarWithImage key={props.src} {...props} />;
}

function AvatarWithImage({
  src,
  alt = "",
  referrerPolicy,
  fallback,
  size,
  className,
}: AvatarProps) {
  const [loaded, setLoaded] = useState(false);
  return (
    <span
      data-slot="avatar"
      className={cn(avatarVariants({ size }), className)}
    >
      {src && (
        <img
          data-slot="avatar-image"
          src={src}
          alt={alt}
          referrerPolicy={referrerPolicy}
          className={cn(
            "aspect-square size-full rounded-full object-cover",
            !loaded && "absolute opacity-0",
          )}
          aria-hidden={!loaded || undefined}
          ref={(image) => {
            if (!loaded && image?.complete && image.naturalWidth > 0)
              setLoaded(true);
          }}
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(false)}
        />
      )}
      {!loaded && (
        <span
          data-slot="avatar-fallback"
          className="flex size-full items-center justify-center rounded-full bg-muted text-muted-foreground"
        >
          {fallback}
        </span>
      )}
    </span>
  );
}
