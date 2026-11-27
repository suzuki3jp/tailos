"use client";

import { IconCheck, IconChevronDown } from "@tabler/icons-react";
import { cva, type VariantProps } from "class-variance-authority";
import { Header } from "react-aria-components/Header";
import {
  Button as AriaButton,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Popover,
  Select as AriaSelect,
  SelectValue,
  Text,
  type PopoverProps,
  type SelectProps as AriaSelectProps,
} from "react-aria-components/Select";
import { cn } from "../../lib/cn";
import { Label } from "./label";

const selectTriggerVariants = cva(
  "flex w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pr-2 pl-2.5 font-normal text-control whitespace-nowrap transition-colors outline-none select-none data-focus-visible:border-ring data-focus-visible:ring-3 data-focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 group-data-invalid/select:border-destructive group-data-invalid/select:ring-3 group-data-invalid/select:ring-destructive/20 dark:bg-input/30 dark:hover:bg-input/50 dark:group-data-invalid/select:border-destructive/50 dark:group-data-invalid/select:ring-destructive/40",
  {
    variants: {
      size: {
        xs: "h-5.5 gap-1 rounded-md px-2 py-0.75 pr-1.5 text-control-xs",
        sm: "h-7 rounded-[min(var(--radius-md),10px)]",
        default: "h-8",
        lg: "h-9",
      },
      variant: {
        outline: "",
        ghost: "border-transparent hover:bg-accent",
      },
    },
    defaultVariants: { size: "default", variant: "outline" },
  },
);

export type SelectOption = {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

export type SelectGroup = {
  id: string;
  label: string;
  options: readonly SelectOption[];
};

type SelectProps = Pick<
  AriaSelectProps,
  "value" | "defaultValue" | "name" | "placeholder" | "isRequired" | "isInvalid"
> &
  VariantProps<typeof selectTriggerVariants> & {
    options: readonly (SelectOption | SelectGroup)[];
    onValueChange?: (value: string | null) => void;
    disabled?: boolean;
    className?: string;
    placement?: PopoverProps["placement"];
    popoverClassName?: string;
    optionsLang?: string;
  } & (
    | { label: string; "aria-label"?: never }
    | { "aria-label": string; label?: never }
  );

export function Select({
  label,
  options,
  onValueChange,
  disabled,
  size,
  variant,
  className,
  placement = "bottom",
  popoverClassName,
  optionsLang,
  ...props
}: SelectProps) {
  return (
    <AriaSelect
      {...props}
      className={cn("group/select min-w-0", label && "space-y-2", className)}
      isDisabled={disabled}
      onChange={(key) => onValueChange?.(key === null ? null : String(key))}
    >
      {label && <Label className="space-y-0">{label}</Label>}
      <AriaButton
        data-slot="select-trigger"
        className={selectTriggerVariants({ size, variant })}
      >
        <SelectValue className="min-w-0 flex-1 truncate text-left data-placeholder:text-muted-foreground">
          {({ selectedText, defaultChildren }) =>
            selectedText || defaultChildren
          }
        </SelectValue>
        <IconChevronDown
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
      </AriaButton>
      <Popover
        lang={optionsLang}
        placement={placement}
        offset={4}
        className={cn(
          "z-50 flex max-h-(--available-height) w-(--trigger-width) min-w-36 flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 motion-safe:data-entering:animate-in motion-safe:data-entering:fade-in-0 motion-safe:data-exiting:animate-out motion-safe:data-exiting:fade-out-0 duration-100",
          popoverClassName,
        )}
      >
        <ListBox className="min-h-0 overflow-y-auto p-1 outline-none">
          {options.map((option) =>
            "options" in option ? (
              <ListBoxSection key={option.id} id={option.id}>
                <Header className="px-1.5 py-1 text-xs text-muted-foreground">
                  {option.label}
                </Header>
                {option.options.map((item) => (
                  <SelectItem key={item.id} {...item} />
                ))}
              </ListBoxSection>
            ) : (
              <SelectItem key={option.id} {...option} />
            ),
          )}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}

function SelectItem({ id, label, description, disabled }: SelectOption) {
  return (
    <ListBoxItem
      id={id}
      textValue={label}
      isDisabled={disabled}
      data-slot="select-item"
      className="group/option relative flex w-full cursor-default items-center rounded-md py-1 pr-8 pl-1.5 text-sm outline-none select-none data-disabled:opacity-50 data-focused:bg-accent data-focused:text-accent-foreground"
    >
      <span className="flex min-w-0 flex-col gap-1 wrap-anywhere">
        <Text slot="label">{label}</Text>
        {description && (
          <Text slot="description" className="text-xs text-muted-foreground">
            {description}
          </Text>
        )}
      </span>
      <IconCheck
        aria-hidden="true"
        className="pointer-events-none absolute right-2 hidden size-4 group-data-selected/option:block"
      />
    </ListBoxItem>
  );
}
