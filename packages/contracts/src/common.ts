import { Type, type Static } from '@sinclair/typebox';

export const UuidSchema = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
});
export const DateTimeSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$',
});
export const EmailSchema = Type.String({
  maxLength: 320,
  pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
});

export const ErrorCodeSchema = Type.Union([
  Type.Literal('BAD_REQUEST'),
  Type.Literal('NOT_FOUND'),
  Type.Literal('UNAUTHORIZED'),
  Type.Literal('FORBIDDEN'),
  Type.Literal('CONFLICT'),
  Type.Literal('VALIDATION_ERROR'),
  Type.Literal('UNSUPPORTED_CLIENT'),
  Type.Literal('MEDIA_UNAVAILABLE'),
  Type.Literal('INTERNAL_ERROR'),
]);

export const ErrorResponseSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: ErrorCodeSchema,
        message: Type.String(),
        requestId: Type.String(),
        details: Type.Optional(Type.Unknown()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ErrorCode = Static<typeof ErrorCodeSchema>;
export type ErrorResponse = Static<typeof ErrorResponseSchema>;
