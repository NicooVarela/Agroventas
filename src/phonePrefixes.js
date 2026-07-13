export const PHONE_PREFIX_OPTIONS = [
  { country: 'Uruguay', code: '+598', flag: '🇺🇾', minLength: 8, maxLength: 8 },
  { country: 'Argentina', code: '+54', flag: '🇦🇷', minLength: 10, maxLength: 11 },
  { country: 'Brasil', code: '+55', flag: '🇧🇷', minLength: 10, maxLength: 11 },
  { country: 'Paraguay', code: '+595', flag: '🇵🇾', minLength: 9, maxLength: 9 },
  { country: 'Chile', code: '+56', flag: '🇨🇱', minLength: 9, maxLength: 9 },
]

export const PHONE_COUNTRY_CODES = PHONE_PREFIX_OPTIONS.map((option) =>
  option.code.replace(/\D/g, ''),
)
