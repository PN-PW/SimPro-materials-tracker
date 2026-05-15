---
name: SimPro Materials Tracker project
description: Multi-user Tampermonkey + Supabase system that adds material delivery tracking to SimPro's cost-centre pages
type: project
---

Building a Tampermonkey userscript that augments SimPro (https://powernaturally.simprosuite.com) with a material tracking layer. SimPro cannot store this data natively — custom fields exist only at job level, not at cost-centre or material-allocation level — so an external store is required.

**Stack**: Supabase (Postgres + Auth + Realtime + RLS) as backend; vanilla-JS Tampermonkey script on the client. User supplies SimPro API credentials via .env but v1 is DOM-only — API integration deferred.

**Scope v1**:
- Cost-centre edit page (`/staff/editCostCentre.php`): inject 3 new columns between "Move Difference To" and "Assigned" — Route (WH→ST | SU→WH→ST | SU→ST), Tracking No., Status (Not actioned [default], Ordered, Confirmed, Shipped, Collected by engineer, Collected by customer, Delivered, Receipt Confirmed, Returned). Checkboxes per row + bulk bar (Select All, Route dropdown, Status dropdown, Apply to Selected). Progress bar: equal-weight per line, 100% when all lines at Receipt Confirmed.
- Cost-centre list page (photo 2): progress bar per cost centre, same metric aggregated across its materials. All cost centres get bars including Obsolete/£0.
- Status can jump non-linearly (user can correct mistakes).
- Audit log required (who/when/field/old/new) — enterprise-grade requirement.
- Multi-user concurrent from day one — no single-user prototype phase.
- Duplicate material rows are expected on the same page; row identity must come from SimPro's internal per-allocation ID, not from material code.

**Why**: user wants an enterprise-grade in-place tracking solution without waiting for SimPro to build it natively.

**How to apply**: any design decision should favour correctness + multi-user safety over speed. Every mutation writes an audit record. Row keys must survive duplicate materials on the same page. Match SimPro's existing visual theme when injecting UI.
