'use client';

import { ArrowRight, Camera, Ruler, ShieldCheck, Shirt, Sparkles } from 'lucide-react';
import { useSession } from '@/lib/session';
import { ButtonLink, Card } from '@/components/ui';
import { BodyPreview } from '@/components/body-preview';

const STEPS = [
  {
    icon: Camera,
    title: 'Four photos',
    body: 'Front, back and both sides, in fitted clothes against a plain wall. Two minutes with a phone timer.',
  },
  {
    icon: Ruler,
    title: 'A measured 3D body',
    body: 'We find your joints and outline in each photo, scale them by your height and measure 11 points of your body.',
  },
  {
    icon: Shirt,
    title: 'Your size, explained',
    body: 'Pick a garment and get a size, a fit score, and the reasons — chest, waist, sleeve — behind it.',
  },
];

export default function Landing() {
  const { user } = useSession();
  // Sign-in routes to onboarding itself when height is missing.
  const start = user ? (user.heightCm == null ? '/onboarding?next=/scan' : '/scan') : '/signin?next=/scan';

  return (
    <div>
      <section className="container-page grid items-center gap-12 pb-16 pt-14 lg:grid-cols-[1.1fr_0.9fr] lg:pt-20">
        <div className="animate-fade-up">
          <p className="eyebrow mb-5 flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-accent" /> Body Intelligence
          </p>
          <h1 className="font-display text-5xl leading-[1.02] tracking-tight sm:text-6xl lg:text-7xl">
            Clothes that fit,
            <br />
            <span className="pr-3 italic text-accent">before</span>you buy them.
          </h1>
          <p className="mt-6 max-w-lg text-lg leading-relaxed text-ink-soft">
            Four photos become a 3D model of your body and a profile of your measurements. Every size we
            recommend comes from that profile — with a fit score and the reasons behind it.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <ButtonLink href={start} size="lg">
              {user?.heightCm ? 'Scan my body' : 'Create my Body Profile'} <ArrowRight className="h-4 w-4" />
            </ButtonLink>
            <ButtonLink href="/shop" size="lg" variant="secondary">
              Browse the shop
            </ButtonLink>
          </div>
          <p className="mt-6 flex items-center gap-2 text-sm text-ink-muted">
            <ShieldCheck className="h-4 w-4 text-accent" />
            Your photos are used only to measure you, and deleted after 30 days.
          </p>
        </div>

        <div className="relative mx-auto w-full max-w-md animate-fade-up [animation-delay:120ms]">
          <Card className="relative overflow-hidden p-0">
            <BodyPreview />
          </Card>
        </div>
      </section>

      <section className="container-page">
        <div className="grid gap-4 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <Card key={s.title} className="p-6">
              <div className="mb-5 flex items-center justify-between">
                <span className="grid h-11 w-11 place-items-center rounded-xl bg-accent-soft text-accent">
                  <s.icon className="h-5 w-5" />
                </span>
                <span className="font-display text-3xl text-ink-faint">0{i + 1}</span>
              </div>
              <h3 className="text-lg font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{s.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="container-page mt-20">
        <Card className="grid gap-8 p-8 md:grid-cols-[1fr_1.4fr] md:p-12">
          <div>
            <p className="eyebrow mb-3">Honest numbers</p>
            <h2 className="font-display text-4xl leading-tight">Every measurement carries its uncertainty.</h2>
          </div>
          <div className="space-y-4 text-[15px] leading-relaxed text-ink-soft">
            <p>
              A body scan from a phone is not a tailor&apos;s tape. So each measurement in your profile shows how
              confident we are in it, and the typical error we&apos;ve measured against real tape-measured people.
            </p>
            <p>
              Size recommendations account for that: when you sit between two sizes, we say so, and tell you which
              way to go for the fit you like.
            </p>
          </div>
        </Card>
      </section>
    </div>
  );
}
