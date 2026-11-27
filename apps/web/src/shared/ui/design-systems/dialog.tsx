"use client";

import { IconX } from "@tabler/icons-react";
import { cva, type VariantProps } from "class-variance-authority";
import { useId, type ComponentProps, type ReactNode } from "react";
import {
  Dialog as AriaDialog,
  DialogTrigger,
  Heading,
} from "react-aria-components/Dialog";
import { Modal, ModalOverlay } from "react-aria-components/Modal";
import { cn } from "../../lib/cn";
import { Button } from "./button";

const modalVariants = cva(
  "fixed z-50 flex max-h-dvh flex-col gap-4 overflow-y-auto bg-popover bg-clip-padding text-sm text-popover-foreground shadow-lg motion-safe:transition motion-safe:duration-200 data-entering:opacity-0 data-exiting:opacity-0",
  {
    variants: {
      placement: {
        center:
          "top-1/2 left-1/2 w-[calc(100%-2rem)] max-w-sm -translate-1/2 rounded-lg p-4",
        left: "inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm motion-safe:data-entering:-translate-x-10 motion-safe:data-exiting:-translate-x-10",
        right:
          "inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm motion-safe:data-entering:translate-x-10 motion-safe:data-exiting:translate-x-10",
        top: "inset-x-0 top-0 border-b motion-safe:data-entering:-translate-y-10 motion-safe:data-exiting:-translate-y-10",
        bottom:
          "inset-x-0 bottom-0 border-t motion-safe:data-entering:translate-y-10 motion-safe:data-exiting:translate-y-10",
      },
    },
    defaultVariants: { placement: "center" },
  },
);

export function Dialog(props: ComponentProps<typeof DialogTrigger>) {
  return <DialogTrigger {...props} />;
}

type DialogContentProps = {
  children: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  hideHeading?: boolean;
  showCloseButton?: boolean;
  className?: string;
  lang?: string;
  onClick?: ComponentProps<typeof AriaDialog>["onClick"];
  isDismissable?: boolean;
};

export function DialogContent(props: DialogContentProps) {
  return <DialogPanel {...props} placement="center" />;
}

export function SheetContent({
  side = "right",
  ...props
}: DialogContentProps & { side?: "left" | "right" | "top" | "bottom" }) {
  return <DialogPanel {...props} placement={side} />;
}

function DialogPanel({
  title,
  description,
  children,
  hideHeading,
  showCloseButton = true,
  placement,
  className,
  isDismissable = true,
  ...props
}: DialogContentProps & VariantProps<typeof modalVariants>) {
  const descriptionId = useId();

  return (
    <ModalOverlay
      isDismissable={isDismissable}
      className="fixed inset-0 z-50 bg-black/10 motion-safe:transition-opacity motion-safe:duration-150 data-entering:opacity-0 data-exiting:opacity-0 supports-backdrop-filter:backdrop-blur-xs"
    >
      <Modal
        data-slot={placement === "center" ? "dialog-content" : "sheet-content"}
        className={cn(modalVariants({ placement }), className)}
      >
        <AriaDialog
          {...props}
          aria-describedby={description ? descriptionId : undefined}
          className="flex min-h-0 flex-1 flex-col gap-[inherit] outline-none"
        >
          {({ close }) => (
            <>
              <div
                className={cn(
                  "flex flex-col gap-0.5",
                  hideHeading && "sr-only",
                )}
              >
                <Heading
                  slot="title"
                  className="text-base font-medium text-foreground"
                >
                  {title}
                </Heading>
                {description && (
                  <p
                    id={descriptionId}
                    className="text-sm text-muted-foreground"
                  >
                    {description}
                  </p>
                )}
              </div>
              {children}
              {showCloseButton && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="absolute top-3 right-3"
                  aria-label="Close"
                  onPress={close}
                >
                  <IconX aria-hidden="true" />
                </Button>
              )}
            </>
          )}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}
