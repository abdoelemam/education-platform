import { Types, type UpdateQuery } from 'mongoose';
import { UserModel } from './user.model.js';
import type { UserDocument, UserRole, TeacherStatus } from './user.types.js';

export interface CreateUserData {
  name: string;
  email: string;
  passwordHash: string;
  role?: UserRole;
  teacherStatus?: TeacherStatus;
}

export interface ListTeachersParams {
  status: TeacherStatus;
  skip: number;
  limit: number;
}

export interface ListTeachersResult {
  items: UserDocument[];
  total: number;
}

export interface ReviewTeacherData {
  teacherId: string;
  status: Extract<TeacherStatus, 'approved' | 'rejected'>;
  reviewedBy: string;
  rejectionReason?: string;
}

export class UserRepository {
  /**
   * Find a user by ID. By default passwordHash is not included.
   */
  async findById(id: string): Promise<UserDocument | null> {
    return UserModel.findById(id).exec();
  }

  /**
   * Load the public catalog's instructor fields in one query. Email, role,
   * password hash and teacher-private data are never selected.
   */
  async findPublicByIds(ids: string[]): Promise<UserDocument[]> {
    if (ids.length === 0) {
      return [];
    }

    return UserModel.find({ _id: { $in: ids } })
      .select('name avatar')
      .exec();
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
   * List teacher accounts by their approval status for the admin review queue.
   * Pending applications are oldest-first so the queue is fair; historical
   * statuses are newest-first.
   *
   * Disabled accounts are excluded: an administrator cannot grant access to an
   * account that is unable to sign in. Re-enable the account to make it
   * reviewable again.
   */
  async listTeachers(params: ListTeachersParams): Promise<ListTeachersResult> {
    const filter = { role: 'teacher', teacherStatus: params.status, isActive: true };
    const sort: Record<string, 1 | -1> =
      params.status === 'pending' ? { createdAt: 1 } : { createdAt: -1 };

    const [items, total] = await Promise.all([
      UserModel.find(filter)
        .sort(sort)
        .skip(params.skip)
        .limit(params.limit)
        .exec(),
      UserModel.countDocuments(filter).exec(),
    ]);

    return { items, total };
  }

  /**
   * Find a teacher account by ID. Non-teacher and disabled users are
   * deliberately excluded so they cannot be inspected or reviewed.
   */
  async findTeacherById(id: string): Promise<UserDocument | null> {
    return UserModel.findOne({ _id: id, role: 'teacher', isActive: true }).exec();
  }

  /**
   * Atomically review a pending teacher application. The status condition makes
   * concurrent admin decisions safe: only one decision can win.
   */
  async reviewTeacher(data: ReviewTeacherData): Promise<UserDocument | null> {
    const update: UpdateQuery<UserDocument> = {
      $set: {
        teacherStatus: data.status,
        teacherReviewedAt: new Date(),
        teacherReviewedBy: new Types.ObjectId(data.reviewedBy),
      },
    };

    if (data.status === 'rejected') {
      update.$set!.teacherRejectionReason = data.rejectionReason;
    } else {
      update.$unset = { teacherRejectionReason: 1 };
    }

    return UserModel.findOneAndUpdate(
      { _id: data.teacherId, role: 'teacher', teacherStatus: 'pending', isActive: true },
      update,
      { new: true, runValidators: true },
    ).exec();
  }

  /**
   * Atomically move a rejected teacher application back to pending so the
   * administrator can review it again. The rejected-status condition makes
   * concurrent resubmissions safe: only one request can win.
   *
   * The previous decision metadata is cleared because the new application has
   * not been reviewed yet.
   */
  async reapplyTeacher(teacherId: string): Promise<UserDocument | null> {
    return UserModel.findOneAndUpdate(
      { _id: teacherId, role: 'teacher', teacherStatus: 'rejected', isActive: true },
      {
        $set: { teacherStatus: 'pending' },
        $unset: {
          teacherRejectionReason: 1,
          teacherReviewedAt: 1,
          teacherReviewedBy: 1,
        },
      },
      { new: true },
    ).exec();
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
