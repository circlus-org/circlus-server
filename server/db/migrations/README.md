# Database Migrations

The public Circlus Server repository starts from an open-source baseline and
forward-only upgrades:

| Migration | Description |
|-----------|-------------|
| `001_initial_schema.sql` | Complete schema at the first public server release |
| `002_managed_push_configuration.sql` | Managed Notification Central connection |

Fresh installations apply this baseline automatically through `npm run migrate`
or the bundled Docker Compose migrator service.

Future public schema changes should be added as new numbered migrations:

```text
003_describe_change.sql
004_describe_next_change.sql
```

Do not edit migrations that may already have been published and deployed.
