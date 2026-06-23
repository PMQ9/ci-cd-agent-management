// WebTUI styles elements via custom hyphen-suffixed attributes (is-, box-, …).
// React 19 forwards these to the DOM verbatim; this augmentation just teaches
// TypeScript/JSX that they're allowed on any intrinsic element.
import "react";

declare module "react" {
  interface HTMLAttributes<T> {
    "is-"?: string;
    "box-"?: string;
    "variant-"?: string;
    "cap-"?: string;
    "size-"?: string;
    "shear-"?: string;
    "direction-"?: string;
    "divide-"?: string;
    "bar-"?: string;
  }
}
