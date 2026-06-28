"use client";

import { Field } from "@base-ui/react/field";

import { cn } from "@/lib/utils";

function Label({ className, ...props }: Field.Label.Props) {
  return (
    <Field.Label
      className={cn(
        "flex select-none items-center gap-2 text-xs leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50 group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50",
        className
      )}
      data-slot="label"
      {...props}
    />
  );
}

export { Label };
