-- Telegram bridge: the bot introduces itself in character ("the sleuth").
--
-- Only two fixed lines change: the greeting when an owner adds the bot to a group, and what a guest is told in a
-- private chat. The profile texts, command menu and picture are set by the function's `profile` action.
do $do$
declare
  src text;
  a text := $a$'Hello. I post stUSDS alerts here and answer questions when I am mentioned or replied to.'$a$;
  b text := $b$format(E'The sleuth is in. 🕵️\n\nI tail the Sky stUSDS vault block by block. When withdrawals open up or a big repayment starts moving, this chat hears it first.\n\nQuestions? Mention me (@%s), reply to one of my messages, or use /ask. /status gives the state of play.\n\nOn-chain facts only, times in Bangkok. Not financial advice.', (select t.bot_username from stusds_alert.tg_config t where t.id = 1))$b$;
begin
  select pg_get_functiondef('public.tg_chat_member(jsonb)'::regprocedure) into src;
  if position(a in src) > 0 then
    execute replace(src, a, b);
  elsif position('The sleuth is in.' in src) = 0 then
    raise exception 'tg_chat_member: the greeting to replace was not found';
  end if;
end $do$;

do $do$
declare
  src text;
  a text := $a$'I only answer in group chats that an owner has added me to.'$a$;
  b text := $b$'Private office hours are for owners only. Find me in a group chat I have been added to, mention me there, and I will talk.'$b$;
begin
  select pg_get_functiondef('public.tg_ingest(jsonb)'::regprocedure) into src;
  if position(a in src) > 0 then
    execute replace(src, a, b);
  elsif position('Private office hours' in src) = 0 then
    raise exception 'tg_ingest: the line to replace was not found';
  end if;
end $do$;
