-- A job's costs wait in work in progress until it's invoiced, finished or cancelled. With no
-- invoice, they now go to cost of sales on the day the job was marked finished or cancelled, not
-- back on the dates they were spent: marking an old job done no longer reaches into a closed
-- year (and leaves nothing stuck in work in progress there). Jobs finished before this keep the
-- dates they had.
alter table projects add column if not exists closed_on date;

create or replace function job_cost_recognised_on(p_project uuid, p_date date) returns date language sql stable as $$
  select coalesce(
    (select min(d.issue_date) from documents d
     where d.project_id = p_project and d.kind = 'invoice' and d.status = 'issued' and d.issue_date >= p_date),
    (select greatest(p_date, coalesce(p.closed_on, p_date)) from projects p where p.id = p_project and p.status in ('done', 'cancelled')))
$$;

create or replace function project_closed_on() returns trigger language plpgsql as $$
declare
  lock date;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  select lock_date into lock from settings where id;
  if new.status in ('done', 'cancelled') and old.status not in ('done', 'cancelled') then
    new.closed_on := greatest((now() at time zone 'Africa/Johannesburg')::date, coalesce(lock + 1, '0001-01-01'::date));
  elsif new.status not in ('done', 'cancelled') and old.status in ('done', 'cancelled') then
    -- Reopening a job finished in a closed year would take its costs back out of those books.
    if lock is not null and (old.closed_on <= lock or (old.closed_on is null and (
        exists (select 1 from costs c where c.project_id = new.id and c.date <= lock)
        or exists (select 1 from labour_entries e where e.project_id = new.id and e.date <= lock)))) then
      raise exception 'This job was finished in a closed year, so its costs are in those books. Leave it finished, or move the lock date back first.'
        using errcode = 'SH001';
    end if;
    new.closed_on := null;
  end if;
  return new;
end
$$;
drop trigger if exists projects_closed_on on projects;
create trigger projects_closed_on before update of status on projects for each row execute function project_closed_on();

update books_version set changed = changed + 1;
