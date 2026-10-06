import { UserModel } from './user.model.js';
import type { UserDocument, UserRole, TeacherStatus } from './user.types.js';

export interface CreateUserData {
  name: string;
  email: string;
  passwordHash: string;
  role?: UserRole;
  teacherStatus?: TeacherStatus;
}

export class UserRepository {
  /**
   * Find a user by ID. By default passwordHash is not included.
   */
  async findById(id: string): Promise<UserDocument | null> {
    return UserModel.findById(id).exec();
  }

  /**
   * Find a user by normalized email.
   * If includePassword is true, explicitly selects passwordHash for authentication check.
   */
  async findByEmail(email: string, includePassword = false): Promise<UserDocument | null> {
    const query = UserModel.findOne({ email: email.toLowerCase() });
    if (includePassword) {
      query.select('+passwordHash');
    }
    return query.exec();
  }

  /**
   * Check whether a user already exists with the given email.
   */
  async existsByEmail(email: string): Promise<boolean> {
    const count = await UserModel.countDocuments({ email: email.toLowerCase() }).exec();
    return count > 0;
  }

  /**
   * Create a new user record.
   */
  async create(data: CreateUserData): Promise<UserDocument> {
    const user = new UserModel({
      name: data.name,
      email: data.email.toLowerCase(),
      passwordHash: data.passwordHash,
      role: data.role ?? 'student',
      teacherStatus: data.teacherStatus ?? (data.role === 'teacher' ? 'pending' : 'none'),
    });

    return user.save();
  }

  /**
   * Update a user's last login timestamp.
   */
  async updateLastLogin(id: string, date: Date = new Date()): Promise<void> {
    await UserModel.findByIdAndUpdate(id, { lastLoginAt: date }).exec();
  }

  /**
   * Update arbitrary user fields by ID.
   */
  async updateById(
    id: string,
    update: Partial<Omit<UserDocument, '_id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<UserDocument | null> {
    return UserModel.findByIdAndUpdate(id, update, { new: true }).exec();
  }
}

export const userRepository = new UserRepository();
