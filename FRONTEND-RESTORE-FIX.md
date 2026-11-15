# V1.6.3 Frontend Restore Fix

The previous V1.6.3 bundle accidentally marked `DiagnosticsExport` as the default React export. This caused Vite/React to mount the Copy & Export panel as the entire application, hiding the dashboard.

## Fix
- `DiagnosticsExport` is now a normal named function component.
- `App` is the sole default export again.
- The Copy & Export Center remains inside the Video Details panel, before the QA report.

## Apply
Extract this patch over the V1.6.3 project, then restart the Vite client. No database migration or video regeneration is required.
