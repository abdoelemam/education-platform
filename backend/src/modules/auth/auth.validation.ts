import { z } from 'zod';

/**
 * Validation schema for user registration.
 */
export const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, 'Name must be at least 2 characters long')
    .max(100, 'Name cannot exceed 100 characters'),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Please provide a valid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters long')
    .max(100, 'Password cannot exceed 100 characters')
    .regex(
      /^(?=.*[A-Za-z])(?=.*\d)/,
      'Password must contain at least one letter and one number',
    ),
  role: z
    .enum(['student', 'teacher'], {
      errorMap: () => ({ message: "Role must be either 'student' or 'teacher'" }),
    })
    .optional()
    .default('student'),
});

export type RegisterInput = z.infer<typeof registerSchema>;

/**
 * Validation schema for user login.
 */
export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email('Please provide a valid email address'),
  password: z
    .string()
    .min(1, 'Password is required'),
});

export type LoginInput = z.infer<typeof loginSchema>;
