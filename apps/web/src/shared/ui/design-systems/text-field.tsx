"use client";

import {
  FieldError,
  Input as AriaInput,
  TextArea as AriaTextArea,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
} from "react-aria-components/TextField";
import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Label } from "./label";

// Home / Design Systems / TextField & TextArea in Figma.
const fieldControlClassName =
  "w-full min-w-0 rounded-sm border border-input bg-background text-foreground transition-colors outline-none placeholder:text-muted-foreground data-focused:not-data-invalid:border-input-focus data-invalid:border-destructive data-disabled:cursor-not-allowed data-disabled:opacity-50";

type FieldProps = Omit<
  AriaTextFieldProps,
  "className" | "style" | "children" | "render"
> & {
  className?: string;
  placeholder?: string;
} & (
    | { label: string; "aria-label"?: never }
    | { "aria-label": string; label?: never }
  );

export type TextFieldProps = FieldProps &
  Pick<InputHTMLAttributes<HTMLInputElement>, "min" | "max" | "step"> & {
    inputClassName?: string;
  };

export type TextAreaProps = FieldProps & {
  rows?: number;
  textAreaClassName?: string;
};

function FieldFrame({
  label,
  className,
  children,
  ...props
}: Omit<FieldProps, "placeholder"> & { children: ReactNode }) {
  return (
    <AriaTextField
      {...props}
      className={cn("flex min-w-0 flex-col gap-2", className)}
    >
      {label && <Label className="space-y-0">{label}</Label>}
      {children}
      <FieldError className="text-sm text-danger" />
    </AriaTextField>
  );
}

export function TextField({
  placeholder,
  min,
  max,
  step,
  inputClassName,
  ...props
}: TextFieldProps) {
  return (
    <FieldFrame {...props}>
      <AriaInput
        data-slot="text-field"
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        className={cn(
          fieldControlClassName,
          "h-8 px-3 py-1.5 text-body",
          inputClassName,
        )}
      />
    </FieldFrame>
  );
}

export function TextArea({
  placeholder,
  rows,
  textAreaClassName,
  ...props
}: TextAreaProps) {
  return (
    <FieldFrame {...props}>
      <AriaTextArea
        data-slot="text-area"
        placeholder={placeholder}
        rows={rows}
        className={cn(
          fieldControlClassName,
          "field-sizing-content min-h-16 px-1.5 pt-1 pb-1.5 text-caption",
          textAreaClassName,
        )}
      />
    </FieldFrame>
  );
}
