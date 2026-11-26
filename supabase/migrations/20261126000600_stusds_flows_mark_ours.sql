-- Flows table: say so when the taker was one of our own contracts.
do $$
declare d text;
begin
  d := pg_get_viewdef('stusds_alert.v_dash_flows'::regclass, true);
  if position('OURS' in d) = 0 then
    d := replace(d, 'tk.entity AS taken_by',
      'CASE WHEN lower(tk.entity) = ANY (ARRAY[''0x01662b082432859c366ab16362eab10fb72c73e6'', ''0xbf54f2aa78b4c240e34224073aff9e89cd915897'', ''0xa2749a6d8de66523c9132d964b5c61d363a5fbe3'', ''0xc2a9c6e9a2d94e6dc3e94737bd57489042367bf1'', ''0x5139a9951f3cdc8de4c0a627ef8d9bc706eb2caf'', ''0x47d40588adac1af6b4d9d33ab7774c3bccd6dbc8'']) THEN ''OURS '' || tk.entity ELSE tk.entity END AS taken_by');
    execute 'create or replace view stusds_alert.v_dash_flows with (security_invoker = true) as ' || d;
  end if;
end $$;
