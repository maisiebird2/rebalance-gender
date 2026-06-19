-- Clear booking/management/contact info from the artists table.
-- Run this in the Supabase SQL editor before re-running
-- `npm run enrich-bios -- --force` with the updated parsing logic.

update artists
set
  booking_info = null,
  management_info = null,
  contact_info = null;
