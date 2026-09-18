'use client';
import { useId, useState } from 'react';
import {
  optionsFor,
  DOMAINS,
  suggestOptions,
  type AuditOptions,
} from '@/lib/audit-options';
import { validateRules } from '@/lib/audit';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { type Rules } from '@/lib/audit';
function Column({
  label,
  value,
  headers,
  onChange,
}: {
  label: string;
  value: string;
  headers: string[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <label className="field" htmlFor={id}>
      {label}
      <Select
        value={value || '__none'}
        onValueChange={(v) => onChange(v === '__none' ? '' : String(v))}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">Choose a column</SelectItem>
          {headers.map((h) => (
            <SelectItem key={h} value={h}>
              {h}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
function Confirm({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="rule-toggle">
      <Checkbox
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <span>{children}</span>
    </label>
  );
}
export function CheckSettings({
  open,
  onOpenChange,
  headers,
  draft,
  setDraft,
  onSave,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  headers: string[];
  draft: Rules;
  setDraft: React.Dispatch<React.SetStateAction<Rules>>;
  onSave: () => void;
  error: string;
}) {
  const field = <K extends keyof Rules>(key: K, value: Rules[K]) =>
    setDraft((r) => ({ ...r, [key]: value }));
  const a = optionsFor(draft);
  const option = <K extends keyof AuditOptions>(
    key: K,
    value: AuditOptions[K],
  ) => field('audit', { ...a, [key]: value });
  const [profileName, setProfileName] = useState('');
  const [profiles, setProfiles] = useState<{ name: string; rules: Rules }[]>(
    () => {
      if (typeof window === 'undefined') return [];
      try {
        const saved = JSON.parse(
          localStorage.getItem('cleanroom-profiles-v1') || '[]',
        );
        return Array.isArray(saved) ? saved.slice(0, 5) : [];
      } catch {
        return [];
      }
    },
  );
  const [profileMessage, setProfileMessage] = useState('');
  const state = (active: boolean) => (
    <span className={`setting-state ${active ? 'enabled' : ''}`}>
      {active ? 'On' : 'Not set'}
    </span>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="settings-dialog">
        <DialogHeader>
          <DialogTitle>What would you like to check?</DialogTitle>
          <DialogDescription>
            We’ve matched the column names we recognize. Open any check to
            adjust it. Extra repair options need your confirmation.
          </DialogDescription>
        </DialogHeader>
        <div className="audit-setup">
          <label className="field" htmlFor="audit-goal">
            What would you like to find?
            <Textarea
              id="audit-goal"
              rows={2}
              maxLength={1000}
              value={a.goal}
              placeholder="For example: Check employee emails and missing IDs"
              onChange={(e) => option('goal', e.target.value)}
            />
          </label>
          <div className="settings-columns">
            <label className="field" htmlFor="audit-domain">
              Type of data
              <select
                id="audit-domain"
                className="large-select"
                value={a.domain}
                onChange={(e) =>
                  option('domain', e.target.value as AuditOptions['domain'])
                }
              >
                {Object.entries(DOMAINS).map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" htmlFor="audit-sensitivity">
              Unusual-value sensitivity
              <select
                id="audit-sensitivity"
                className="large-select"
                value={a.sensitivity}
                onChange={(e) =>
                  option(
                    'sensitivity',
                    e.target.value as AuditOptions['sensitivity'],
                  )
                }
              >
                <option value="broad">Broad scan · 1 × IQR</option>
                <option value="balanced">Balanced · 1.5 × IQR</option>
                <option value="strict">High confidence · 3 × IQR</option>
              </select>
            </label>
          </div>
          <Button
            variant="outline"
            onClick={() => {
              setDraft(suggestOptions(headers, draft, a.goal, a.domain));
              setProfileMessage(
                'Suggestions are ready below. Review them, then save your checks. No repairs were enabled automatically.',
              );
            }}
          >
            Suggest my audit plan
          </Button>
          <p className="setting-help">
            Local suggestions match familiar words and column names. Numeric
            limits, correct labels, and business assumptions come from you.
            Sensitivity changes the outlier threshold only.
          </p>
        </div>
        <Accordion
          defaultValue={[]}
          multiple={false}
          className="settings-accordion"
        >
          <AccordionItem value="custom-rules">
            <AccordionTrigger>
              <span>
                <b>Your rules & limits</b>
                <small>Required fields, email checks, and numeric ranges</small>
              </span>
              {state(!!a.required.length || !!a.emailColumn || !!a.rangeColumn)}
            </AccordionTrigger>
            <AccordionContent>
              <p className="setting-help">
                Select fields that must contain a value.
              </p>
              <div className="required-columns">
                {headers.map((h) => (
                  <Confirm
                    key={h}
                    checked={a.required.includes(h)}
                    onChange={(v) =>
                      option(
                        'required',
                        v
                          ? [...a.required, h]
                          : a.required.filter((c) => c !== h),
                      )
                    }
                  >
                    {h}
                  </Confirm>
                ))}
              </div>
              <Column
                label="Email column (optional)"
                value={a.emailColumn}
                headers={headers}
                onChange={(v) => option('emailColumn', v)}
              />
              <p className="setting-help">
                Checks the address structure only. It does not prove the mailbox
                exists or contact anyone.
              </p>
              <Column
                label="Numeric column (optional)"
                value={a.rangeColumn}
                headers={headers}
                onChange={(v) => option('rangeColumn', v)}
              />
              <div className="settings-columns">
                <label className="field" htmlFor="minimum">
                  Minimum
                  <Input
                    id="minimum"
                    type="number"
                    value={a.minimum ?? ''}
                    onChange={(e) =>
                      option(
                        'minimum',
                        e.target.value === '' ? null : Number(e.target.value),
                      )
                    }
                  />
                </label>
                <label className="field" htmlFor="maximum">
                  Maximum
                  <Input
                    id="maximum"
                    type="number"
                    value={a.maximum ?? ''}
                    onChange={(e) =>
                      option(
                        'maximum',
                        e.target.value === '' ? null : Number(e.target.value),
                      )
                    }
                  />
                </label>
              </div>
              <label className="field" htmlFor="custom-severity">
                Priority for violations of these rules
                <select
                  id="custom-severity"
                  className="large-select"
                  value={a.severity}
                  onChange={(e) =>
                    option(
                      'severity',
                      e.target.value as AuditOptions['severity'],
                    )
                  }
                >
                  {['low', 'medium', 'high', 'critical'].map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="profiles">
            <AccordionTrigger>
              <span>
                <b>Reusable audit profiles</b>
                <small>Save these choices on this device</small>
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <label className="field" htmlFor="profile-name">
                Profile name
                <Input
                  id="profile-name"
                  value={profileName}
                  maxLength={60}
                  onChange={(e) => setProfileName(e.target.value)}
                />
              </label>
              <Button
                variant="outline"
                disabled={!profileName.trim()}
                onClick={() => {
                  try {
                    validateRules(draft, headers);
                    const next = [
                      { name: profileName.trim(), rules: draft },
                      ...profiles.filter((p) => p.name !== profileName.trim()),
                    ].slice(0, 5);
                    localStorage.setItem(
                      'cleanroom-profiles-v1',
                      JSON.stringify(next),
                    );
                    setProfiles(next);
                    setProfileMessage('Profile saved on this device.');
                  } catch (e) {
                    setProfileMessage((e as Error).message);
                  }
                }}
              >
                Save profile
              </Button>
              {profiles.map((p) => (
                <Button
                  key={p.name}
                  variant="ghost"
                  onClick={() => {
                    try {
                      validateRules(p.rules, headers);
                      setDraft(p.rules);
                      setProfileMessage(
                        'Profile loaded. Review the rules before saving.',
                      );
                    } catch {
                      setProfileMessage(
                        'This profile uses different column names. Adjust the checks for this file.',
                      );
                    }
                  }}
                >
                  {p.name}
                </Button>
              ))}
              {!!profiles.length && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    localStorage.removeItem('cleanroom-profiles-v1');
                    setProfiles([]);
                    setProfileMessage('Saved profiles removed.');
                  }}
                >
                  Clear saved profiles
                </Button>
              )}
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="identity">
            <AccordionTrigger>
              <span>
                <b>Repeated rows</b>
                <small>Look for entries with the same ID</small>
              </span>
              {state(!!draft.idColumn)}
            </AccordionTrigger>
            <AccordionContent>
              <Column
                label="Which column identifies a row?"
                value={draft.idColumn}
                headers={headers}
                onChange={(v) => field('idColumn', v)}
              />
              <p className="setting-help">
                Repeated IDs are flagged for review. To suggest removing an
                identical extra row, confirm the rule below.
              </p>
              <Confirm
                checked={draft.uniqueIds}
                onChange={(v) => field('uniqueIds', v)}
              >
                Each ID should appear only once in this file.
              </Confirm>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="dates">
            <AccordionTrigger>
              <span>
                <b>Dates</b>
                <small>Spot dates that need a closer look</small>
              </span>
              {state(!!draft.dateColumn)}
            </AccordionTrigger>
            <AccordionContent>
              <Column
                label="Which column contains dates?"
                value={draft.dateColumn}
                headers={headers}
                onChange={(v) => field('dateColumn', v)}
              />
              <p className="setting-help">
                Checks dates written as year-month-day, like 2026-09-18. An
                impossible date gets flagged; we won’t guess the replacement.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="outliers">
            <AccordionTrigger>
              <span>
                <b>Unusual numbers</b>
                <small>Flag values that stand out from the rest</small>
              </span>
              {state(draft.checkOutliers && !!draft.outlierColumn)}
            </AccordionTrigger>
            <AccordionContent>
              <Column
                label="Which numeric column should we look at?"
                value={draft.outlierColumn}
                headers={headers}
                onChange={(v) => field('outlierColumn', v)}
              />
              <Confirm
                checked={draft.checkOutliers}
                onChange={(v) => field('checkOutliers', v)}
              >
                Highlight unusual values for me to review.
              </Confirm>
              <p className="setting-help">
                A large order may be completely valid. This check never suggests
                replacing a number just because it is unusual.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="quantity">
            <AccordionTrigger>
              <span>
                <b>Missing quantities</b>
                <small>Work out a quantity from price and total</small>
              </span>
              {state(draft.arithmetic)}
            </AccordionTrigger>
            <AccordionContent>
              <div className="settings-columns">
                {(
                  ['quantityColumn', 'priceColumn', 'totalColumn'] as const
                ).map((key, i) => (
                  <Column
                    key={key}
                    label={
                      ['Quantity column', 'Unit price column', 'Total column'][
                        i
                      ]
                    }
                    value={draft[key]}
                    headers={headers}
                    onChange={(v) => field(key, v)}
                  />
                ))}
              </div>
              <Confirm
                checked={draft.arithmetic}
                onChange={(v) => field('arithmetic', v)}
              >
                Price and total are reliable. Total = quantity × price, with no
                taxes, discounts or refunds.
              </Confirm>
              <p className="setting-help">
                We suggest a quantity only when the answer is an exact positive
                whole number.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="categories">
            <AccordionTrigger>
              <span>
                <b>Names & categories</b>
                <small>Make spacing and capitalization consistent</small>
              </span>
              {state(
                draft.normalizeCategories &&
                  !!draft.categoryColumn &&
                  !!draft.categories.length,
              )}
            </AccordionTrigger>
            <AccordionContent>
              <Column
                label="Which column contains the labels?"
                value={draft.categoryColumn}
                headers={headers}
                onChange={(v) => field('categoryColumn', v)}
              />
              <label className="field" htmlFor="approved-names">
                Correct labels, separated by commas
                <Input
                  id="approved-names"
                  placeholder="For example: Coffee, Tea, Sandwich"
                  value={draft.categories.join(',')}
                  onChange={(e) =>
                    field('categories', e.target.value.split(','))
                  }
                />
              </label>
              <Confirm
                checked={draft.normalizeCategories}
                onChange={(v) => field('normalizeCategories', v)}
              >
                These are the correct labels. Normalize surrounding spaces and
                capitalization to match.
              </Confirm>
              <p className="setting-help">
                Only extra surrounding spaces and letter case are corrected.
                Unfamiliar names are left for you to review.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="units">
            <AccordionTrigger>
              <span>
                <b>Grams & kilograms</b>
                <small>Put measurements in the same unit</small>
              </span>
              {state(draft.convertUnits)}
            </AccordionTrigger>
            <AccordionContent>
              <div className="settings-columns">
                <Column
                  label="Measurement column"
                  value={draft.valueColumn}
                  headers={headers}
                  onChange={(v) => field('valueColumn', v)}
                />
                <Column
                  label="Unit column"
                  value={draft.unitColumn}
                  headers={headers}
                  onChange={(v) => field('unitColumn', v)}
                />
              </div>
              <label className="field" htmlFor="target-unit">
                Use this unit
                <Select
                  value={draft.targetUnit}
                  onValueChange={(v) => field('targetUnit', v as 'kg' | 'g')}
                >
                  <SelectTrigger id="target-unit" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="kg">Kilograms (kg)</SelectItem>
                    <SelectItem value="g">Grams (g)</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <Confirm
                checked={draft.convertUnits}
                onChange={(v) => field('convertUnits', v)}
              >
                The unit labels are reliable. Convert grams and kilograms,
                updating the value and its label together.
              </Confirm>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="missing">
            <AccordionTrigger>
              <span>
                <b>How missing values are written</b>
                <small>Optional · tell us which marks mean “empty”</small>
              </span>
            </AccordionTrigger>
            <AccordionContent>
              <label className="field" htmlFor="missing-tokens">
                Missing-value markers, separated by commas
                <Input
                  id="missing-tokens"
                  placeholder="For example: ?, N/A, NULL"
                  value={draft.missingTokens.filter(Boolean).join(',')}
                  onChange={(e) =>
                    field('missingTokens', [
                      '',
                      ...e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    ])
                  }
                />
              </label>
              <p className="setting-help">
                Empty cells are always treated as missing.
              </p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
        {profileMessage && (
          <output className="setting-help">{profileMessage}</output>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSave}>
            Confirm audit plan <span aria-hidden="true">✓</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
