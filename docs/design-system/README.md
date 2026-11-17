# Tailos design system

The visual reference is the [Home frame](https://www.figma.com/design/8xCaWOhzVybu2PXiJ3Hrij/tailos?node-id=21-10905) and [Design Systems page](https://www.figma.com/design/8xCaWOhzVybu2PXiJ3Hrij/tailos?node-id=6-2). Treat Figma as read-only. Home reads the authenticated account's Project and Session lists. The composer does not start a Run. See [the home API integration decision](../pdr/records/PDR-20261117-home-api-integration.md).

## Ownership

- `apps/web/src/shared/styles/tokens.css`: semantic colors, typography and radii. `index.css` is the stylesheet's public entry.
- `apps/web/src/shared/ui`: shadcn Base UI / Nova components, adapted in place for Tailos. Import each component's public module, such as `@/shared/ui/button`.
- `apps/web/src/shared/lib/cn.ts`: class merging, including Tailos's semantic font-size names. Adding a typography utility also requires registering its name here so it does not conflict with text colors.
- `apps/web/src/_pages/home`: home layout, API query options, selection state and Session presentation. Queries use the existing credentialed API client and remain in the page slice.
- `apps/web/src/app/(management)`: existing public management routes, currently composed with the prototype layout. These screens may adopt new styles, fonts and icons freely; preserving their previous appearance is not a requirement. Root login errors continue to render the account screen. See [the prototype styling decision](../pdr/records/PDR-20261116-web-prototype-styles.md).

## Tokens

| Figma | Token | Light value |
| --- | --- | --- |
| light-bg-primary | background | `#fffcf5` |
| light-font-primary | foreground | `#271e18` |
| light-font-secondary | muted-foreground | `#63584a` |
| light-border | border / input | `#ded4c3` |
| light-button-primary | primary | `#855333` |
| light-font-danger | destructive | `#a42b2b` |

Home headings and Session titles currently use black in Figma, exposed separately as `foreground-strong`. Card, popover and sidebar backgrounds alias `background`. The exported unread asset uses `#004ebb`; it is separate from Run state. The Select focus example uses `#d4d4d4` for its ring. An unlayered `:focus-visible` rule adds a solid primary outline to keyboard-focused controls, overriding the primitives' `outline-none` utilities.

Secondary, muted and hover surfaces are supplemental UI values, mixed from the existing border and background colors. They are not additional colors already specified by Figma. The theme is light-only; no dark theme is enabled.

Geist is self-hosted through the pinned Fontsource package. Font sizes / line heights are `display` 40/40, `page-title` 26/26, `section-title` 22/26.4, `body` 16/16, `caption` 14/14, `control` 14/20 and `control-xs` 12/16 pixels. HTML heading levels express document structure independently of visual size. Radii are 6, 8 and 10 pixels. Use Tailwind's spacing scale for the 4, 6, 8, 10, 12, 24, 36, 48 and 60 pixel spacing in the reference.

`paper`, `panel`, `ink`, `rule`, `signal`, `danger` and `accent-ink` are temporary aliases used by the prototype management screens. They can be migrated to the new tokens without preserving the old appearance. Old text uses of `muted` were migrated to `muted-foreground`; `muted` now means a subtle surface. Do not use legacy color names in new UI.

## Components

- **Button**: `default` for primary actions, `outline` for bordered alternatives, `ghost` for unobtrusive controls. Icon buttons need an accessible name.
- **Select**: `default` 32px, `sm` 28px, `xs` 22px, `lg` 36px. The `ghost` variant is used in the composer; the sidebar uses the bordered variant. Both controls share a selection, initially the first Project returned by the API. Choices show Project names and repositories, including later API pages. Loading, failures and empty lists disable the controls; selection is not persisted across reloads. It remains a non-editable Select; a searchable Combobox can be added when required.
- **InputGroup**: shared focus boundary around a textarea and a `block-end` action area. Clicking the action area must not steal focus from its Select or buttons. The composer preserves the draft and reports that preview submission did not send it.
- **Avatar**: a generic account icon until the API supplies user identity. Sample imagery is not presented as the authenticated user.
- **Dialog / Sheet**: shared dialog primitives and mobile navigation. Escape and focus restoration remain provided by Base UI.
- **Recent Sessions**: rows link to the actual Session detail page and display the API's trigger, timestamp and latest Run status. The account-wide list follows API ordering, loads later pages on request, and handles loading, empty, login and retry states. Project selection does not filter this list. Unread marks are not inferred from Run state.

The static desktop sidebar is page composition; it does not add shadcn's optional cookie-backed collapsing behavior. Mobile uses Sheet for focus containment and dismissal.

The Web CSP permits `style` attributes through `style-src-attr 'unsafe-inline'`. JavaScript restrictions and the nonce requirement for `<style>` elements remain in place. The root layout passes the Worker's per-response CSP nonce to Base UI's `CSPProvider`, so library-generated style elements use that nonce. Select renders directly in server HTML; there is no hydration fallback or duplicate scrollbar stylesheet. See [the CSP decision](../pdr/records/PDR-20261116-csp-style-attributes.md).

## Updating shadcn

Run `pnpm --filter @tailos/web ui:add <component>` using the pinned workspace CLI. `components.json` points generation at Shared. Review the generated diff: Shared-internal imports must be relative, and generated `cn` imports must use the local helper so semantic typography stays intact. Do not overwrite Tailos customizations without reviewing them.

The icon library is Tabler Icons (`iconLibrary: "tabler"`). Import individual icons from `@tabler/icons-react`; do not add Lucide. Use `currentColor` and explicit sizes, and hide decorative icons from assistive technology. Accessible names belong on the control. See [the icon decision](../pdr/records/PDR-20261116-web-icons.md) and [Tabler's React documentation](https://docs.tabler.io/icons/libraries/react).

## Assets

Project-specific Figma imagery and decorations are downloaded under `apps/web/public/assets/design-system`. Temporary Figma asset URLs are not runtime sources. Generic icons are rendered with Tabler components instead of duplicated SVG exports.

| Asset | Figma node / slot |
| --- | --- |
| tailos-symbol.png | Page / Sidebar Head / Logo |
| demo-avatar.png | Page / Main Head / アイコン 1 |
| unread.svg | Card Item / Unread |
| separator.svg | Card Item / Line |

## Verification

Compare the home at 1320 × 832 with the reference: sidebar 240px, header 60px, content 640px inside 24px gutters, 48px top padding, 140px initial composer and 60px between sections. Use minimum heights rather than clipping long content. Check narrow screens, synchronized Project selection, Sheet dismissal and focus restoration, draft retention, Session pagination and error recovery. Home only reads the two list APIs; composer submission must not create a Session or Run. Verify built Worker output under the existing CSP; external fonts and images are not needed.

Run the same checks as CI: `pnpm format:check`, `pnpm lint`, `pnpm test`, `pnpm typecheck`, and `pnpm --filter @tailos/web run build`.
