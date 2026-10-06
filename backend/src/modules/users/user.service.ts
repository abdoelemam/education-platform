import { userRepository, type UserRepository } from './user.repository.js';
import { toPublicUser } from './user.mapper.js';
import type { PublicUser, UserDocument } from './user.types.js';
import { AppError } from '../../errors/index.js';

export class UserService {
  constructor(private readonly userRepo: UserRepository = userRepository) {}

  /**
   * Retrieve a user by ID and return their sanitized public profile.
   */
  async getUserProfile(userId: string): Promise<PublicUser> {
    const user = await this.userRepo.findById(userId);
    if (!user) {
      throw AppError.notFound('User');
    }
    return toPublicUser(user);
  }

  /**
   * Retrieve raw user document for internal operations (e.g. auth checks).
   */
  async findById(userId: string): Promise<UserDocument | null> {
    return this.userRepo.findById(userId);
  }

  /**
   * Find user by email.
   */
  async findByEmail(email: string, includePassword = false): Promise<UserDocument | null> {
    return this.userRepo.findByEmail(email, includePassword);
  }
}

export const userService = new UserService();
