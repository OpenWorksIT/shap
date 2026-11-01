-- Sign-in limits per account count recent failures in the audit log.
-- SPDX-License-Identifier: AGPL-3.0-or-later
create index if not exists audit_log_action_at on audit_log(action, at);
