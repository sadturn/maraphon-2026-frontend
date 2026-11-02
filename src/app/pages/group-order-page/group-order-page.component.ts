import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { finalize, forkJoin, map, switchMap } from 'rxjs';
import { GroupOrdersService } from '@app/services/group-orders/group-orders.service';
import { ToastService } from '@app/services/toast/toast.service';
import { GuestInvite } from '@app/models/reservations/guest-invite.model';
import { Participant } from '@app/models/group-orders/participant.model';
import { GroupReservationStatus } from '@app/models/group-orders/group-status.model';
import { consolidatePreOrder } from '@app/shared/helpers/consolidate-pre-order';
import { ModalComponent } from '@app/shared/custom-components/modal/modal.component';
import { ParticipantCardComponent } from '@app/components/group-orders/participant-card/participant-card.component';

type LoadState = 'loading' | 'ready' | 'not-found' | 'error';

const STATUS_LABELS: Record<GroupReservationStatus, string> = {
  Open: 'Collecting pre-orders',
  Submitted: 'Sent to Restaurant',
  Closed: 'Closed',
};

@Component({
  selector: 'app-group-order-page',
  imports: [ParticipantCardComponent, ModalComponent, CurrencyPipe, DatePipe],
  templateUrl: './group-order-page.component.html',
  styleUrl: './group-order-page.component.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class GroupOrderPageComponent implements OnInit {
  private readonly groupOrdersService = inject(GroupOrdersService);
  private readonly toastService = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly reservationId = inject(ActivatedRoute).snapshot.paramMap.get('reservationId') ?? '';

  readonly loadState = signal<LoadState>('loading');
  readonly invite = signal<GuestInvite | null>(null);
  readonly participants = signal<Participant[]>([]);
  readonly ownSessionId = signal('');
  readonly status = signal<GroupReservationStatus>('Open');
  readonly isConfirmOpen = signal(false);
  readonly isSubmitting = signal(false);

  // у замовлення ресторану йдуть лише підтверджені кошики
  readonly consolidated = computed(() => consolidatePreOrder(this.participants()));
  readonly statusLabel = computed(() => STATUS_LABELS[this.status()]);
  readonly isOpen = computed(() => this.status() === 'Open');
  readonly hasAnyDishes = computed(() => this.participants().some((person) => person.items.length > 0));
  readonly pendingCount = computed(() => this.participants().filter((person) => !person.isSubmitted).length);
  readonly pendingMessage = computed(() => {
    const count = this.pendingCount();
    const subject = count === 1 ? '1 participant hasn’t' : `${count} participants haven’t`;
    return `${subject} submitted their cart yet — their dishes won’t be included in the order`;
  });
  readonly canSubmit = computed(
    () => this.isOpen() && this.consolidated().items.length > 0 && !this.isSubmitting(),
  );

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loadState.set('loading');

    this.groupOrdersService
      .getGroupInvite$(this.reservationId)
      .pipe(
        switchMap((invite) =>
          forkJoin({
            sessions: this.groupOrdersService.getSessions$(invite.GroupReservationId),
            ownSessionId: this.groupOrdersService.getOwnerSessionId$(this.reservationId),
            groupStatus: this.groupOrdersService.getStatus$(invite.GroupReservationId),
          }).pipe(map((data) => ({ invite, ...data }))),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: ({ invite, sessions, ownSessionId, groupStatus }) => {
          this.invite.set(invite);
          this.participants.set(sessions.participants);
          this.ownSessionId.set(ownSessionId);
          this.status.set(groupStatus.status);
          this.loadState.set('ready');
        },
        error: (error: unknown) => {
          const notFound = error instanceof HttpErrorResponse && error.status === 404;
          this.loadState.set(notFound ? 'not-found' : 'error');
        },
      });
  }

  openConfirm(): void {
    if (this.canSubmit()) {
      this.isConfirmOpen.set(true);
    }
  }

  closeConfirm(): void {
    if (!this.isSubmitting()) {
      this.isConfirmOpen.set(false);
    }
  }

  submit(): void {
    const invite = this.invite();
    // захист від подвійного кліку: поки запит іде, другий не відправляємо
    if (!invite || !this.canSubmit()) {
      return;
    }

    this.isSubmitting.set(true);
    this.groupOrdersService
      .submit$(invite.GroupReservationId, this.reservationId)
      .pipe(
        finalize(() => {
          this.isSubmitting.set(false);
          this.isConfirmOpen.set(false);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.status.set('Submitted');
          this.toastService.success('Pre-order sent to the restaurant');
        },
        // помилку вже показав tokenInterceptor — тут лише лишаємо кнопку активною
        error: () => undefined,
      });
  }
}
