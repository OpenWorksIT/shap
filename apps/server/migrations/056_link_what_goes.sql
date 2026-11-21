-- Which list of what goes to a linked practice its owner agreed to (LINK_WHAT_GOES_VERSION): a link
-- made before 1.33 was told less (not the date of incorporation or the Compensation Fund), so
-- its practice isn't sent those.
alter table accountant_links add column if not exists what_goes integer not null default 1;
