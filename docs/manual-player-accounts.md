# Manual Player Accounts

Use this for the friend-group MVP while self-service email sign-up is disabled.

## Username Convention

The app accepts a simple username, then signs into Supabase with a reserved email address:

```text
username -> username@players.mudslingers.test
```

Full email addresses still work for older test users.

## Create A Player

1. Open Supabase.
2. Go to **Authentication -> Users**.
3. Add a user with an email like `maya@players.mudslingers.test`.
4. Set the password you want to give that player.
5. Confirm the user if Supabase offers that option.
6. Run this SQL to set the visible name and colour:

```sql
update public.profiles
set display_name = 'Maya',
    player_color = '#ba3c3a'
where id = (
  select id
  from auth.users
  where lower(email) = lower('maya@players.mudslingers.test')
);
```

The player signs into the app with:

```text
Username: maya
Password: the-password-you-set
```

## Suggested Colours

```text
#21745c
#2f5f9f
#ba3c3a
#8a5b20
#7a4ab8
#d36b2c
#0f766e
#be185d
#4338ca
#0891b2
#4d7c0f
#b45309
#e11d48
#475569
#6d28d9
#047857
#0369a1
#db2777
#6b8e23
#9f1239
```
