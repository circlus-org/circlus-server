# Database Migrations

The public Circlus Server repository starts from a single open-source baseline:

| Migration | Description |
|-----------|-------------|
| `001_initial_schema.sql` | Complete schema at the first public server release |

Fresh installations apply this baseline automatically through `npm run migrate`
or the bundled Docker Compose migrator service.

Future public schema changes should be added as new numbered migrations:

```text
002_describe_change.sql
003_describe_next_change.sql
```

Do not edit migrations that may already have been published and deployed.
